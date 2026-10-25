# /// script
# requires-python = ">=3.10"
# dependencies = ["mcp>=2.3,<3", "requests>=2.31"]
# ///
"""Serwer MCP z frekwencją i ocenami z Librus Synergia.

Dane pochodzą prosto z Librusa, czyli z tego samego źródła, z którego korzysta
frekwencja.edu.pl, ale login i hasło trafiają tylko do Librusa.

Login i hasło: plik .env obok tego skryptu (LIBRUS_LOGIN, LIBRUS_HASLO)
albo zmienne środowiskowe o tych samych nazwach.

    uv run --script librus_mcp.py           # serwer MCP (stdio) dla Claude
    uv run --script librus_mcp.py --test    # szybki test w terminalu
"""
from __future__ import annotations

import json
import math
import os
import random
import sys
import time
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import requests
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

OAUTH = "https://api.librus.pl/OAuth"
SYNERGIA = "https://synergia.librus.pl"
PORTAL_LOGIN = f"{SYNERGIA}/loguj/portalRodzina"
GATEWAY = f"{SYNERGIA}/gateway/api/2.0"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
)
TIMEOUT = 30
CACHE_TTL = 600  # s; Claude często pyta kilka razy z rzędu, nie ma sensu za każdym razem pobierać wszystkiego
DNI = ["poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota", "niedziela"]


class LibrusError(ToolError):
    """Błąd, którego treść ma zobaczyć Claude (inne wyjątki SDK zamienia na samo 'Error executing tool')."""


def load_env() -> None:
    path = Path(__file__).with_name(".env")
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if value:  # czytane przy każdym logowaniu, więc poprawka w .env działa bez restartu
            os.environ[key.strip()] = value


def baner_header() -> str:
    """Nagłówek x-baner, który dokłada do logowania strona Librusa (OAuth/js/Authorization.js):
    losowa liczba i czas w ms, każdy znak przesunięty o 20 w Unicode."""
    shift = lambda text: "".join(chr(ord(c) + 20) for c in text)
    return f"{shift(str(random.random()))}_{shift(str(int(time.time() * 1000)))}"


def librus_url(value: str, base: str) -> str:
    """Adres z przekierowania przy logowaniu; dopuszczamy tylko https na domenach librus.pl."""
    url = urljoin(base, value)
    parts = urlsplit(url)
    host = parts.hostname or ""
    if parts.scheme != "https" or not (host == "librus.pl" or host.endswith(".librus.pl")):
        raise LibrusError(f"Nieoczekiwany adres przy logowaniu do Librusa: {host or url}")
    return url


def redirect_target(response: requests.Response, base: str) -> str:
    location = response.headers.get("Location")
    if not location:
        raise LibrusError(f"Librus nie przekierował dalej przy logowaniu ({response.url}, HTTP {response.status_code}).")
    return librus_url(location, base)


def normalize(text: str) -> str:
    return text.lower().translate(str.maketrans("ąćęłńóśźż", "acelnoszz"))


def today() -> date:
    return date.today()


def to_int(value) -> int | None:
    """Librus podaje Id i numery lekcji raz jako liczby, raz jako tekst."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def check_date(value: str | None, name: str) -> str | None:
    if value is None:
        return None
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        raise LibrusError(f"Parametr {name} musi mieć format RRRR-MM-DD, a jest: {value!r}")


class Librus:
    def __init__(self) -> None:
        self.session: requests.Session | None = None
        self.cache: dict[str, tuple[float, object]] = {}
        self.lessons: dict[int, dict] = {}
        self.rejected: tuple[tuple[str, str], str] | None = None
        self.landing = ""

    def login(self) -> requests.Session:
        try:
            return self._login()
        except requests.RequestException as e:
            raise LibrusError(f"Brak połączenia z Librusem przy logowaniu: {e}") from e

    def _login(self) -> requests.Session:
        load_env()
        user = os.environ.get("LIBRUS_LOGIN", "").strip()
        password = os.environ.get("LIBRUS_HASLO", "").strip("\r\n")  # wklejone w panelu Vercela bywa z Enterem
        if not user or not password:
            raise LibrusError(
                "Brak loginu lub hasła. Uzupełnij LIBRUS_LOGIN i LIBRUS_HASLO: lokalnie w pliku .env obok "
                "librus_mcp.py, na Vercelu w Settings → Environment Variables (potem Redeploy)."
            )
        if "@" in user:
            raise LibrusError("Podaj login do Librus Synergia (np. 1234567u), a nie e-mail z Librus Rodzina.")
        # Ponawianie złego hasła kończy się CAPTCHA, więc tych samych danych nie próbujemy drugi raz.
        if self.rejected and self.rejected[0] == (user, password):
            raise LibrusError(f"{self.rejected[1]} Popraw LIBRUS_LOGIN / LIBRUS_HASLO (w .env albo w zmiennych Vercela).")

        s = requests.Session()
        s.headers["User-Agent"] = USER_AGENT
        get = lambda url, referer: s.get(url, headers={"Referer": referer}, allow_redirects=False, timeout=TIMEOUT)

        # Ta sama droga co w przeglądarce i w Mati365/librus-api: start w Synergii daje OAuth
        # adres powrotu i state, więc po zalogowaniu Librus wraca do Synergii i zakłada tam sesję.
        auth_url = redirect_target(get(PORTAL_LOGIN, "https://portal.librus.pl/"), PORTAL_LOGIN)
        login_url = redirect_target(get(auth_url, PORTAL_LOGIN), auth_url)
        get(login_url, auth_url)

        # Po kilku nieudanych próbach Librus chce CAPTCHA. Wtedy nie próbujemy dalej,
        # żeby nie przedłużać blokady: trzeba raz zalogować się ręcznie w przeglądarce.
        try:
            captcha = s.post(f"{OAUTH}/Captcha", data={"username": user, "is_needed": 1}, timeout=TIMEOUT).json()
        except ValueError:
            captcha = {}
        if captcha.get("is_needed"):
            raise LibrusError(
                "Librus wymaga teraz CAPTCHA dla tego konta (za dużo prób logowania). "
                "Zaloguj się raz ręcznie na https://synergia.librus.pl i spróbuj ponownie później."
            )

        r = s.post(
            login_url,
            data={"action": "login", "login": user, "pass": password},
            headers={
                "x-baner": baner_header(),
                "X-Requested-With": "XMLHttpRequest",
                "Accept": "application/json, text/javascript, */*; q=0.01",
                "Referer": login_url,
                "Origin": "https://api.librus.pl",
            },
            allow_redirects=False,
            timeout=TIMEOUT,
        )
        target = r.headers.get("Location")
        if not target:
            try:
                result = r.json()
            except ValueError:
                raise LibrusError(f"Nieoczekiwana odpowiedź Librusa przy logowaniu (HTTP {r.status_code}).")
            status = result.get("status")
            if status == "actionRequired":
                raise LibrusError(
                    "Librus wymaga dodatkowej akcji na koncie (np. zmiany hasła albo akceptacji regulaminu). "
                    "Zaloguj się ręcznie na https://synergia.librus.pl i dokończ ją."
                )
            if status != "ok" or not result.get("goTo"):
                errors = "; ".join(e.get("message") or e.get("code", "") for e in result.get("errors", []))
                message = f"Logowanie do Librusa nieudane: {errors or status}."
                if status == "error":
                    self.rejected = ((user, password), message)
                raise LibrusError(message)
            target = result["goTo"]

        url, referer = librus_url(target, login_url), login_url
        for _ in range(10):
            r = get(url, referer)
            if not (300 <= r.status_code < 400 and r.headers.get("Location")):
                break
            referer, url = url, librus_url(r.headers["Location"], url)
        else:
            raise LibrusError("Za dużo przekierowań przy logowaniu do Librusa.")
        landing = urlsplit(url)
        self.landing = f"{landing.hostname}{landing.path} (HTTP {r.status_code})"  # do diagnostyki w --test
        self.session = s
        return s

    def request(self, url: str) -> requests.Response:
        """GET na Synergii; jeśli stara sesja wygasła (401), loguje się raz od nowa."""
        fresh = self.session is None
        session = self.session or self.login()
        for attempt in range(2):
            try:
                r = session.get(url, timeout=TIMEOUT)
            except requests.RequestException as e:
                raise LibrusError(f"Brak połączenia z Librusem ({url}): {e}") from e
            if r.status_code != 401 or fresh or attempt:
                return r
            session = self.login()

    def get(self, path: str) -> dict:
        r = self.request(f"{GATEWAY}/{path}")
        if r.status_code != 200:
            raise LibrusError(f"Librus odrzucił zapytanie {path} (HTTP {r.status_code}): {r.text[:200]}")
        try:
            return r.json()
        except ValueError:
            raise LibrusError(f"Librus zwrócił coś innego niż JSON dla {path}: {r.text[:200]}")

    def fetch(self, path: str, key: str):
        hit = self.cache.get(path)
        if hit and time.time() - hit[0] < CACHE_TTL:
            return hit[1]
        value = self.get(path).get(key)
        self.cache[path] = (time.time(), value)
        return value

    def subject_names(self) -> dict[int, str]:
        return {to_int(s["Id"]): s.get("Name", "?") for s in self.fetch("Subjects", "Subjects") or []}

    def lesson_subject(self, lesson_id: int | None, subjects: dict[int, str]) -> str:
        if not self.lessons:
            self.lessons = {l["Id"]: l for l in self.fetch("Lessons", "Lessons") or []}
        lesson = self.lessons.get(lesson_id)
        if lesson is None and lesson_id is not None:
            try:
                lesson = self.get(f"Lessons/{lesson_id}").get("Lesson") or {}
            except LibrusError:
                lesson = {}
            self.lessons[lesson_id] = lesson
        subject_id = to_int(((lesson or {}).get("Subject") or {}).get("Id"))
        return subjects.get(subject_id, "Nieznany przedmiot")

    def student(self) -> dict:
        me = self.fetch("Me", "Me") or {}
        person = me.get("Account") or me.get("User") or {}
        info = {"imie_nazwisko": f"{person.get('FirstName', '')} {person.get('LastName', '')}".strip()}
        class_id = (me.get("Class") or {}).get("Id")
        if class_id:
            try:
                cls = self.fetch(f"Classes/{class_id}", "Class") or {}
            except LibrusError:
                cls = {}
            if cls:
                info["klasa"] = f"{cls.get('Number', '')}{cls.get('Symbol', '')}"
                info["koniec_1_semestru"] = cls.get("EndFirstSemester")
                info["koniec_roku"] = cls.get("EndSchoolYear")
        return info

    def current_semester(self) -> int:
        end_first = (self.student().get("koniec_1_semestru") or "")[:10]
        if end_first:
            return 1 if today().isoformat() <= end_first else 2
        semesters = [a.get("Semester") for a in self.fetch("Attendances", "Attendances") or [] if a.get("Semester")]
        return max(semesters, default=1)


lib = Librus()
mcp = MCPServer("librus", instructions="Frekwencja i oceny ucznia z Librus Synergia. Daty zawsze RRRR-MM-DD.")


def attendance_rows(semestr: int | None, od: str | None, do: str | None, przedmiot: str | None) -> list[dict]:
    od, do = check_date(od, "od"), check_date(do, "do")
    types = {t["Id"]: t for t in lib.fetch("Attendances/Types", "Types") or []}
    subjects = lib.subject_names()
    rows = []
    for a in lib.fetch("Attendances", "Attendances") or []:
        day = a.get("Date") or ""
        if semestr and a.get("Semester") != semestr:
            continue
        if (od and day < od) or (do and day > do):
            continue
        subject = lib.lesson_subject((a.get("Lesson") or {}).get("Id"), subjects)
        if przedmiot and normalize(przedmiot) not in normalize(subject):
            continue
        kind = types.get((a.get("Type") or {}).get("Id"), {})
        rows.append({
            "data": day,
            "dzien": DNI[date.fromisoformat(day).weekday()] if day else None,
            "lekcja_nr": a.get("LessonNo"),
            "przedmiot": subject,
            "typ": kind.get("Name", "?"),
            "skrot": kind.get("Short", "?"),
            "obecnosc": bool(kind.get("IsPresenceKind")),
            "semestr": a.get("Semester"),
        })
    rows.sort(key=lambda r: (r["data"], r["lekcja_nr"] or 0))
    return rows


def attendance_stats(rows: list[dict], prog: float) -> dict:
    total = len(rows)
    present = sum(r["obecnosc"] for r in rows)
    stats = {
        "lekcje": total,
        "obecnosci": present,
        "nieobecnosci": total - present,
        "frekwencja_proc": round(100 * present / total, 2) if total else None,
        "wg_typu": dict(Counter(r["typ"] for r in rows).most_common()),
    }
    if total:
        spare = math.floor(present * 100 / prog - total + 1e-9)
        stats["mozna_jeszcze_opuscic"] = max(spare, 0)
        # Ile lekcji z rzędu trzeba być obecnym, żeby (obecności + n) / (lekcje + n) >= próg.
        stats["obecnosci_do_progu"] = 0
        if spare < 0:
            stats["ponizej_progu"] = True
            stats["obecnosci_do_progu"] = (
                math.ceil((prog * total - 100 * present) / (100 - prog) - 1e-9) if prog < 100 else None
            )
    return stats


def grade_value(grade: str | None) -> float | None:
    """Wartość do średniej jak w Librusie: '+' to +0.5, '-' to -0.25; np, nb, +, - się nie liczą."""
    grade = (grade or "").strip()
    if not grade[:1].isdigit():
        return None
    value = float(grade[0])
    if grade[1:2] == "+":
        value += 0.5
    elif grade[1:2] == "-":
        value -= 0.25
    return value


@mcp.tool()
def frekwencja(
    semestr: int | None = None,
    od: str | None = None,
    do: str | None = None,
    przedmiot: str | None = None,
    prog: float = 50,
) -> dict:
    """Frekwencja ucznia z Librusa: ogółem i osobno dla każdego przedmiotu, domyślnie w bieżącym semestrze.

    Dla każdego przedmiotu: liczba lekcji, obecności, nieobecności, procent frekwencji,
    rozbicie na typy wpisów (obecność, nieobecność, spóźnienie, usprawiedliwiona...) oraz:
    - obecnosci_do_progu: na ilu kolejnych lekcjach trzeba być (bez żadnej nieobecności),
      żeby dobić do progu; 0, gdy próg jest już osiągnięty,
    - mozna_jeszcze_opuscic: ile kolejnych lekcji można opuścić, zanim frekwencja spadnie poniżej progu.

    Args:
        semestr: 1 albo 2; domyślnie bieżący semestr; 0 = cały rok szkolny.
        od: data początkowa RRRR-MM-DD (włącznie).
        do: data końcowa RRRR-MM-DD (włącznie).
        przedmiot: fragment nazwy przedmiotu, np. "mat"; domyślnie wszystkie.
        prog: próg frekwencji w procentach (domyślnie 50, próg nieklasyfikowania).
    """
    if not 0 < prog <= 100:
        raise LibrusError("prog musi być z przedziału (0, 100].")
    if semestr is None:
        semestr = lib.current_semester()
    rows = attendance_rows(semestr or None, od, do, przedmiot)
    by_subject = defaultdict(list)
    for r in rows:
        by_subject[r["przedmiot"]].append(r)
    return {
        "uczen": lib.student(),
        "zakres": {"semestr": semestr or "cały rok", "od": od, "do": do, "przedmiot": przedmiot},
        "prog_proc": prog,
        "ogolem": attendance_stats(rows, prog),
        "przedmioty": [
            {"przedmiot": name, **attendance_stats(subject_rows, prog)}
            for name, subject_rows in sorted(by_subject.items(), key=lambda item: normalize(item[0]))
        ],
        "uwaga": "Obecność to wpisy, które Librus oznacza jako obecność (np. obecność, spóźnienie).",
    }


def compact(entry: dict) -> dict:
    return {k: v for k, v in entry.items() if v not in (None, "", [], {})}


def lookup(path: str, key: str, label) -> dict[int, str]:
    """Słownik Id -> nazwa z pomocniczego zasobu Librusa; brak dostępu nie psuje wyniku narzędzia."""
    try:
        items = lib.fetch(path, key) or []
    except LibrusError:
        return {}
    return {to_int(item.get("Id")): label(item) for item in items}


def teacher_names() -> dict[int, str]:
    return lookup("Users", "Users", lambda u: f"{u.get('FirstName', '')} {u.get('LastName', '')}".strip())


def classroom_names() -> dict[int, str]:
    return lookup("Classrooms", "Classrooms", lambda c: c.get("Symbol") or c.get("Name"))


def subject_name(ref: dict | None, subjects: dict[int, str]) -> str:
    ref = ref or {}
    return subjects.get(to_int(ref.get("Id"))) or ref.get("Name") or "Nieznany przedmiot"


def person(ref: dict | None, teachers: dict[int, str]) -> str | None:
    ref = ref or {}
    return f"{ref.get('FirstName', '')} {ref.get('LastName', '')}".strip() or teachers.get(to_int(ref.get("Id")))


def timetable_entries(start: date, end: date):
    """Wpisy planu Librusa od start do end włącznie, razem z odwołanymi: (data, wpis)."""
    monday = start - timedelta(days=start.weekday())
    while monday <= end:
        week = lib.fetch(f"Timetables?weekStart={monday.isoformat()}", "Timetable") or {}
        for day, slots in sorted(week.items()):
            if not start.isoformat() <= day <= end.isoformat():
                continue
            for slot in slots.values() if isinstance(slots, dict) else slots or []:
                for entry in [slot] if isinstance(slot, dict) else slot or []:
                    yield day, entry
        monday += timedelta(days=7)


def timetable_lessons(start: date, end: date) -> list[tuple[str, str, int | None]]:
    """Lekcje z planu Librusa od start do end włącznie, bez odwołanych: (przedmiot, data, nr lekcji)."""
    subjects = lib.subject_names()
    return [
        (subject_name(entry.get("Subject"), subjects), day, to_int(entry.get("LessonNo")))
        for day, entry in timetable_entries(start, end)
        if not entry.get("IsCanceled")
    ]


def free_days(start: date, end: date) -> list[dict]:
    """Dni wolne szkoły nachodzące na zakres (jeśli szkoła je wpisała i Librus je udostępnia)."""
    try:
        items = lib.fetch("Calendars/SchoolFreeDays", "SchoolFreeDays") or []
    except LibrusError:
        return []
    return [
        compact({"od": f.get("DateFrom"), "do": f.get("DateTo"), "nazwa": f.get("Name")})
        for f in items
        if (f.get("DateFrom") or "")[:10] <= end.isoformat() and (f.get("DateTo") or f.get("DateFrom") or "")[:10] >= start.isoformat()
    ]


def date_range(od: str | None, do: str | None, default_start: date, default_days: int, max_days: int) -> tuple[date, date]:
    start = date.fromisoformat(check_date(od, "od") or default_start.isoformat())
    end = date.fromisoformat(check_date(do, "do") or (start + timedelta(days=default_days)).isoformat())
    if end < start:
        raise LibrusError("Data 'do' jest wcześniejsza niż 'od'.")
    if (end - start).days > max_days:
        raise LibrusError(f"Za długi zakres: najwyżej {max_days} dni naraz.")
    return start, end


def semester_forecast(rows: list[dict], left: int, prog: float) -> dict:
    stats = attendance_stats(rows, prog)
    present, total = stats["obecnosci"], stats["lekcje"]
    # Ile z pozostałych lekcji można opuścić, żeby na koniec mieć (obecności + zostało - x) / (lekcje + zostało) >= próg.
    allowed = math.floor(present + left - prog * (total + left) / 100 + 1e-9)
    return {
        "lekcje": total,
        "obecnosci": present,
        "frekwencja_proc": stats["frekwencja_proc"],
        "zostalo_lekcji": left,
        "obecnosci_do_progu": stats.get("obecnosci_do_progu", 0),
        "zdazysz": allowed >= 0,
        "mozna_opuscic_do_konca": min(max(allowed, 0), left),
        "max_frekwencja_na_koniec_proc": round(100 * (present + left) / (total + left), 2) if total + left else None,
    }


@mcp.tool()
def do_konca_semestru(prog: float = 50, przedmiot: str | None = None, koniec: str | None = None) -> dict:
    """Czy zdążysz dobić do progu frekwencji do końca bieżącego semestru, według planu lekcji z Librusa.

    Dla każdego przedmiotu: obecna frekwencja w semestrze oraz
    - zostalo_lekcji: lekcje z planu od dziś do końca semestru (bez odwołanych i bez tych, które mają już wpis),
    - obecnosci_do_progu: na ilu kolejnych lekcjach trzeba być, żeby dobić do progu,
    - zdazysz: czy będąc na wszystkich pozostałych lekcjach skończysz semestr co najmniej na progu,
    - mozna_opuscic_do_konca: ile z pozostałych lekcji można opuścić i nadal skończyć semestr na progu,
    - max_frekwencja_na_koniec_proc: frekwencja na koniec, jeśli będziesz na wszystkich pozostałych lekcjach.
    Plan z Librusa nie zawsze uwzględnia dni wolne (święta, ferie, wycieczki), więc lekcji może realnie być mniej.

    Args:
        prog: próg frekwencji w procentach (domyślnie 50).
        przedmiot: fragment nazwy przedmiotu; domyślnie wszystkie.
        koniec: ostatni dzień do policzenia RRRR-MM-DD; domyślnie koniec bieżącego semestru z Librusa.
    """
    if not 0 < prog <= 100:
        raise LibrusError("prog musi być z przedziału (0, 100].")
    semestr = lib.current_semester()
    end = check_date(koniec, "koniec")
    if not end:
        end = (lib.student().get("koniec_1_semestru" if semestr == 1 else "koniec_roku") or "")[:10]
    if not end:
        raise LibrusError("Librus nie podaje daty końca semestru; podaj ją w parametrze koniec (RRRR-MM-DD).")

    all_rows = attendance_rows(semestr, None, None, None)
    done = {(r["data"], to_int(r["lekcja_nr"])) for r in all_rows}  # dzisiejsze lekcje z wpisem już się odbyły
    wanted = lambda name: not przedmiot or normalize(przedmiot) in normalize(name)
    remaining = Counter(
        name for name, day, no in timetable_lessons(today(), date.fromisoformat(end))
        if (day, no) not in done and wanted(name)
    )
    by_subject = defaultdict(list)
    for r in all_rows:
        if wanted(r["przedmiot"]):
            by_subject[r["przedmiot"]].append(r)
    return {
        "semestr": semestr,
        "od": today().isoformat(),
        "koniec": end,
        "prog_proc": prog,
        "ogolem": semester_forecast([r for rs in by_subject.values() for r in rs], sum(remaining.values()), prog),
        "przedmioty": [
            {"przedmiot": name, **semester_forecast(by_subject.get(name, []), remaining.get(name, 0), prog)}
            for name in sorted(set(by_subject) | set(remaining), key=normalize)
        ],
        "uwaga": "Pozostałe lekcje policzone z planu Librusa; dni wolnych, których szkoła nie wpisała, nie widać.",
    }


@mcp.tool()
def plan_lekcji(od: str | None = None, do: str | None = None) -> dict:
    """Plan lekcji z Librusa dzień po dniu: numer lekcji, godziny, przedmiot, nauczyciel, sala,
    odwołane lekcje i zastępstwa (z tym, co było w planie zamiast nich) oraz dni wolne.
    Odwołania i zastępstwa szkoła wpisuje zwykle dzień lub dwa wcześniej, więc dalszy plan może się zmienić.

    Args:
        od: pierwszy dzień RRRR-MM-DD; domyślnie poniedziałek bieżącego tygodnia (w weekend: następnego).
        do: ostatni dzień RRRR-MM-DD (najwyżej 31 dni od 'od'); domyślnie piątek tego tygodnia,
            a gdy podano samo 'od' – tydzień od tego dnia.
    """
    d = today()
    if d.weekday() >= 5:
        d += timedelta(days=7 - d.weekday())
    start, end = date_range(od, do, d - timedelta(days=d.weekday()), 4 if od is None else 6, 31)
    subjects, teachers, rooms = lib.subject_names(), teacher_names(), classroom_names()
    days = defaultdict(list)
    for day, e in timetable_entries(start, end):
        lesson = {
            "nr": to_int(e.get("LessonNo")),
            "godziny": f"{e['HourFrom']}–{e.get('HourTo', '?')}" if e.get("HourFrom") else None,
            "przedmiot": subject_name(e.get("Subject"), subjects),
            "nauczyciel": person(e.get("Teacher"), teachers),
            "sala": rooms.get(to_int((e.get("Classroom") or {}).get("Id"))),
            "odwolana": True if e.get("IsCanceled") else None,
            "uwaga": e.get("SubstitutionNote"),
        }
        if e.get("IsSubstitutionClass"):
            lesson["zastepstwo"] = True
            lesson["zamiast"] = compact({
                "przedmiot": subject_name(e["OrgSubject"], subjects) if e.get("OrgSubject") else None,
                "nauczyciel": person(e.get("OrgTeacher"), teachers) if e.get("OrgTeacher") else None,
                "sala": rooms.get(to_int((e.get("OrgClassroom") or {}).get("Id"))),
                "data": e.get("OrgDate"),
                "lekcja_nr": to_int(e.get("OrgLessonNo")),
            })
        days[day].append(compact(lesson))
    return {
        "od": start.isoformat(),
        "do": end.isoformat(),
        "dni": [
            {"data": day, "dzien": DNI[date.fromisoformat(day).weekday()],
             "lekcje": sorted(lessons, key=lambda l: l.get("nr") or 0)}
            for day, lessons in sorted(days.items())
        ],
        "dni_wolne": free_days(start, end),
    }


@mcp.tool()
def terminarz(
    od: str | None = None,
    do: str | None = None,
    przedmiot: str | None = None,
    kategoria: str | None = None,
) -> dict:
    """Terminarz z Librusa: sprawdziany, kartkówki, prace klasowe, wycieczki i inne wydarzenia,
    z datą, numerem lekcji, kategorią, przedmiotem, opisem i nauczycielem, który je wpisał.
    Widać tylko to, co nauczyciele wpisali do terminarza w Librusie.

    Args:
        od: pierwszy dzień RRRR-MM-DD; domyślnie dziś.
        do: ostatni dzień RRRR-MM-DD; domyślnie 14 dni od 'od' (najwyżej 366 dni naraz).
        przedmiot: fragment nazwy przedmiotu.
        kategoria: fragment nazwy kategorii, np. "sprawdzian", "kartk".
    """
    start, end = date_range(od, do, today(), 14, 366)
    categories = lookup("HomeWorks/Categories", "Categories", lambda c: c.get("Name"))
    subjects, teachers = lib.subject_names(), teacher_names()
    events = []
    for ev in lib.fetch("HomeWorks", "HomeWorks") or []:
        day = (ev.get("Date") or "")[:10]
        if not start.isoformat() <= day <= end.isoformat():
            continue
        category = categories.get(to_int((ev.get("Category") or {}).get("Id"))) or "Inne"
        subject = subject_name(ev.get("Subject"), subjects) if ev.get("Subject") else None
        if przedmiot and normalize(przedmiot) not in normalize(subject or ""):
            continue
        if kategoria and normalize(kategoria) not in normalize(category):
            continue
        events.append(compact({
            "data": day,
            "dzien": DNI[date.fromisoformat(day).weekday()],
            "lekcja_nr": to_int(ev.get("LessonNo")),
            "godziny": f"{ev['TimeFrom']}–{ev.get('TimeTo', '?')}" if ev.get("TimeFrom") else None,
            "kategoria": category,
            "przedmiot": subject,
            "opis": (ev.get("Content") or "").strip(),
            "wpisal": person(ev.get("CreatedBy"), teachers),
            "dodano": (ev.get("AddDate") or "")[:10],
        }))
    events.sort(key=lambda e: (e["data"], e.get("lekcja_nr") or 0))
    return {"od": start.isoformat(), "do": end.isoformat(), "liczba": len(events), "wydarzenia": events,
            "dni_wolne": free_days(start, end)}


@mcp.tool()
def nieobecnosci(
    od: str | None = None,
    do: str | None = None,
    przedmiot: str | None = None,
    semestr: int | None = None,
    typ: str | None = None,
) -> dict:
    """Lista konkretnych wpisów frekwencji innych niż zwykła obecność: nieobecności
    (usprawiedliwione i nie), spóźnienia, zwolnienia itd., z datą, dniem tygodnia,
    numerem lekcji i przedmiotem, od najstarszych.

    Args:
        od: data początkowa RRRR-MM-DD (włącznie).
        do: data końcowa RRRR-MM-DD (włącznie).
        przedmiot: fragment nazwy przedmiotu.
        semestr: 1 albo 2.
        typ: fragment nazwy albo skrót typu, np. "nieusprawiedliwiona", "nb", "sp".
    """
    rows = [
        r for r in attendance_rows(semestr, od, do, przedmiot)
        if not (r["obecnosc"] and r["skrot"].lower() == "ob")
    ]
    if typ:
        wanted = normalize(typ)
        rows = [r for r in rows if wanted == normalize(r["skrot"]) or wanted in normalize(r["typ"])]
    return {"liczba": len(rows), "wpisy": rows}


@mcp.tool()
def oceny(przedmiot: str | None = None, semestr: int | None = None) -> dict:
    """Oceny z Librusa według przedmiotów: cząstkowe (z kategorią, wagą i datą), średnia ważona
    liczona jak w Librusie ('+' = +0.5, '-' = -0.25) oraz oceny i propozycje semestralne/roczne.

    Args:
        przedmiot: fragment nazwy przedmiotu; domyślnie wszystkie.
        semestr: 1 albo 2; domyślnie cały rok.
    """
    categories = {c["Id"]: c for c in lib.fetch("Grades/Categories", "Categories") or []}
    subjects = lib.subject_names()
    per_subject = defaultdict(lambda: {"czastkowe": [], "koncowe": []})
    for g in lib.fetch("Grades", "Grades") or []:
        if semestr and g.get("Semester") != semestr:
            continue
        name = subjects.get((g.get("Subject") or {}).get("Id"), "Nieznany przedmiot")
        if przedmiot and normalize(przedmiot) not in normalize(name):
            continue
        category = categories.get((g.get("Category") or {}).get("Id"), {})
        entry = {
            "ocena": g.get("Grade"),
            "kategoria": category.get("Name"),
            "data": g.get("Date"),
            "semestr": g.get("Semester"),
        }
        if g.get("IsConstituent"):
            weight = category.get("Weight")
            entry["waga"] = 1 if weight is None else weight
            entry["do_sredniej"] = bool(category.get("CountToTheAverage", True)) and grade_value(g.get("Grade")) is not None
            per_subject[name]["czastkowe"].append(entry)
        else:
            final = g.get("IsFinal") or g.get("IsFinalProposition")
            proposal = g.get("IsSemesterProposition") or g.get("IsFinalProposition")
            entry["rodzaj"] = ("proponowana " if proposal else "") + ("roczna" if final else "semestralna")
            per_subject[name]["koncowe"].append(entry)

    result = []
    for name, data in sorted(per_subject.items(), key=lambda item: normalize(item[0])):
        counted = [(grade_value(e["ocena"]), e["waga"]) for e in data["czastkowe"] if e["do_sredniej"]]
        weights = sum(w for _, w in counted)
        result.append({
            "przedmiot": name,
            "srednia_wazona": round(sum(v * w for v, w in counted) / weights, 2) if weights else None,
            "oceny": sorted(data["czastkowe"], key=lambda e: e["data"] or ""),
            "koncowe": data["koncowe"],
        })
    return {"uczen": lib.student(), "przedmioty": result}


def save_debug_pages() -> None:
    """Zapisuje strony Synergii z frekwencją i ocenami do debug/, żeby dopasować do nich parser HTML."""
    folder = Path(__file__).with_name("debug")
    folder.mkdir(exist_ok=True)
    for name, path in [("frekwencja", "przegladaj_nb/uczen"), ("oceny", "przegladaj_oceny/uczen")]:
        r = lib.request(f"{SYNERGIA}/{path}")
        (folder / f"{name}.html").write_text(r.text, encoding="utf-8")
        print(f"  {path}: HTTP {r.status_code}, {len(r.text)} znaków -> debug/{name}.html")


def save_timetable_debug() -> None:
    folder = Path(__file__).with_name("debug")
    folder.mkdir(exist_ok=True)
    monday = today() - timedelta(days=today().weekday())
    raw = lib.get(f"Timetables?weekStart={monday.isoformat()}")
    (folder / "plan.json").write_text(json.dumps(raw, ensure_ascii=False, indent=1), encoding="utf-8")
    print("  Plan lekcji wygląda na pusty; zapisałem odpowiedź Librusa do debug/plan.json do analizy.")


def run_test() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        lib.login()
        print(f"Logowanie: OK, koniec na {lib.landing}")
        token = lib.request(f"{GATEWAY}/Auth/TokenInfo")
        print(f"API Synergii (Auth/TokenInfo): HTTP {token.status_code}")
        if token.status_code != 200:
            print("API nie przyjmuje sesji, zapisuję strony do analizy:")
            save_debug_pages()
            return
        att = frekwencja()
        grades = oceny()
    except LibrusError as e:
        print(f"BŁĄD: {e}")
        sys.exit(1)
    student = att["uczen"]
    print(f"Zalogowano: {student.get('imie_nazwisko')} {student.get('klasa', '')}".rstrip())
    status = lambda s: (
        f"do 50% musisz być jeszcze {s['obecnosci_do_progu']}×" if s.get("ponizej_progu")
        else f"ok, możesz opuścić {s['mozna_jeszcze_opuscic']}"
    )
    total = att["ogolem"]
    print(f"Semestr {att['zakres']['semestr']}, frekwencja ogółem: {total['frekwencja_proc']}% "
          f"({total['obecnosci']}/{total['lekcje']}), {status(total)}")
    presence = {r["typ"]: r["obecnosc"] for r in attendance_rows(None, None, None, None)}
    print("Typy wpisów: " + ", ".join(
        f"{name} {count}× ({'obecność' if presence.get(name) else 'nieobecność'})"
        for name, count in total["wg_typu"].items()
    ) + "\n")
    for p in att["przedmioty"]:
        print(f"  {p['przedmiot'][:38]:<38} {p['frekwencja_proc']:>6}%  {p['obecnosci']:>3}/{p['lekcje']:<3}  {status(p)}")
    print("\n„Musisz być jeszcze N×” = tyle kolejnych lekcji bez żadnej nieobecności, żeby dobić do 50%.")
    try:
        plan = do_konca_semestru()
    except LibrusError as e:
        print(f"\nPrognoza do końca semestru niedostępna: {e}")
    else:
        print(f"\nDo końca semestru ({plan['koniec']}) wg planu zostało lekcji: {plan['ogolem']['zostalo_lekcji']}")
        if not plan["ogolem"]["zostalo_lekcji"] and plan["od"] <= plan["koniec"]:
            save_timetable_debug()
        for p in plan["przedmioty"]:
            verdict = (
                f"zdążysz: możesz opuścić najwyżej {p['mozna_opuscic_do_konca']}" if p["zdazysz"]
                else f"NIE zdążysz: nawet bez nieobecności skończysz na {p['max_frekwencja_na_koniec_proc']}%"
            )
            print(f"  {p['przedmiot'][:38]:<38} zostało {p['zostalo_lekcji']:>3}   {verdict}")
    count = sum(len(p["oceny"]) for p in grades["przedmioty"])
    print(f"\nOceny: {count} cząstkowych z {len(grades['przedmioty'])} przedmiotów.")
    print_schedule_test()


def save_debug_json(name: str, data) -> None:
    folder = Path(__file__).with_name("debug")
    folder.mkdir(exist_ok=True)
    (folder / name).write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"  Zapisałem odpowiedź Librusa do debug/{name} do analizy.")


def print_schedule_test() -> None:
    monday = today() + timedelta(days=7 - today().weekday())
    try:
        plan = plan_lekcji(od=monday.isoformat(), do=(monday + timedelta(days=4)).isoformat())
    except LibrusError as e:
        print(f"\nPlan lekcji niedostępny: {e}")
    else:
        print(f"\nPlan na przyszły tydzień ({plan['od']} – {plan['do']}):")
        lessons = [l for d in plan["dni"] for l in d["lekcje"]]
        for d in plan["dni"]:
            print(f"  {d['dzien']} {d['data']}:")
            for l in d["lekcje"]:
                flags = " ".join(filter(None, [
                    "ODWOŁANA" if l.get("odwolana") else "",
                    f"ZASTĘPSTWO (zamiast: {l.get('zamiast')})" if l.get("zastepstwo") else "",
                    f"[{l['uwaga']}]" if l.get("uwaga") else "",
                ]))
                print(f"    {l.get('nr', '?')}. {l.get('godziny', '?'):<12} {l['przedmiot'][:34]:<34} "
                      f"{l.get('nauczyciel', '?')} | sala {l.get('sala', '?')} {flags}".rstrip())
        for free in plan["dni_wolne"]:
            print(f"  dzień wolny: {free}")
        missing = [k for k in ("godziny", "nauczyciel", "sala") if lessons and not any(k in l for l in lessons)]
        if missing or not lessons:
            print(f"  Uwaga: brak danych ({', '.join(missing) or 'żadnych lekcji'}).")
            save_debug_json("plan.json", lib.get(f"Timetables?weekStart={monday.isoformat()}"))
    try:
        cal = terminarz(do=(today() + timedelta(days=30)).isoformat())
    except LibrusError as e:
        print(f"\nTerminarz niedostępny: {e}")
        return
    print(f"\nTerminarz na 30 dni, wydarzeń: {cal['liczba']}")
    for ev in cal["wydarzenia"]:
        head = " ".join(filter(None, [
            ev["data"], ev["dzien"][:3], f"lekcja {ev['lekcja_nr']}" if ev.get("lekcja_nr") else "",
            ev["kategoria"], f"({ev['przedmiot']})" if ev.get("przedmiot") else "",
        ]))
        print(f"  {head}: {ev.get('opis', '')[:70]}")
    if len(cal["wydarzenia"]) >= 3 and all(ev["kategoria"] == "Inne" for ev in cal["wydarzenia"]):
        print("  Uwaga: żadne wydarzenie nie ma rozpoznanej kategorii.")
        save_debug_json("terminarz.json", lib.get("HomeWorks/Categories"))


if __name__ == "__main__":
    if "--test" in sys.argv:
        run_test()
    else:
        mcp.run()
