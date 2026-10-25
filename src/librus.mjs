// Dostęp do Librus Synergia przez bibliotekę librus-api (Mati365): logowanie, cache i dane w prostej postaci.
// Biblioteka czyta strony HTML Synergii, więc wszystko poniżej opiera się na tym, co zwracają jej metody.
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = new URL("../", import.meta.url);

export const DNI = ["poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota", "niedziela"];
const DAY_KEYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const TYPY = { nb: "nieobecność", u: "nieobecność uspr.", sp: "spóźnienie", zw: "zwolnienie" };
const NIEOBECNE = new Set(["nb", "u"]); // spóźnienie i zwolnienie Librus liczy jako obecność
const CACHE_TTL = 10 * 60 * 1000; // Claude często pyta kilka razy z rzędu
const SESSION_TTL = 8 * 60 * 1000; // przy wygasłej sesji biblioteka zwraca puste wyniki zamiast błędu
const CONCURRENCY = 3;

// --- konfiguracja i środowisko -------------------------------------------------------------

function loadEnv() {
  const path = new URL(".env", ROOT);
  if (!fs.existsSync(path)) return;
  for (const raw of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const key = line.slice(0, line.indexOf("=")).trim();
    let value = line.slice(line.indexOf("=") + 1).trim();
    if (value.length >= 2 && value[0] === value.at(-1) && `"'`.includes(value[0])) value = value.slice(1, -1);
    if (value) process.env[key] = value; // czytane przy każdym logowaniu, więc poprawka w .env działa bez restartu
  }
}

export function config() {
  const path = new URL("config.json", ROOT);
  const file = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
  const year = Number(schoolYearStart().slice(0, 4));
  return {
    koniec1: process.env.KONIEC_1_SEMESTRU || file.koniec_1_semestru || lastWeekday(`${year + 1}-01-31`, 4),
    koniecRoku: process.env.KONIEC_ROKU || file.koniec_roku || lastWeekday(`${year + 1}-06-30`, 4),
    pozalekcyjne: process.env.POKAZ_POZALEKCYJNE ? process.env.POKAZ_POZALEKCYJNE === "1" : Boolean(file.pokaz_pozalekcyjne),
  };
}

// --- daty (zawsze czas polski, także na Vercelu) -------------------------------------------

export const clock = {
  now() {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      }).formatToParts(new Date()).map((p) => [p.type, p.value]),
    );
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
  },
};

const toUtc = (iso) => new Date(`${iso}T00:00:00Z`);
export const addDays = (iso, n) => new Date(toUtc(iso).getTime() + n * 86400000).toISOString().slice(0, 10);
export const weekday = (iso) => (toUtc(iso).getUTCDay() + 6) % 7; // 0 = poniedziałek
export const mondayOf = (iso) => addDays(iso, -weekday(iso));
export const today = () => clock.now().date;

function lastWeekday(iso, dayIndex) {
  let d = iso;
  while (weekday(d) !== dayIndex) d = addDays(d, -1);
  return d;
}

export function schoolYearStart() {
  const [y, m] = today().split("-").map(Number);
  return `${m >= 8 ? y : y - 1}-09-01`;
}

export function semesterRange(semestr) {
  const { koniec1, koniecRoku } = config();
  return semestr === 2 ? [addDays(koniec1, 1), koniecRoku] : [schoolYearStart(), koniec1];
}

export function currentSemester() {
  return today() <= config().koniec1 ? 1 : 2;
}

export function checkDate(value, name) {
  if (value == null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(toUtc(value).getTime())) {
    throw new Error(`Parametr ${name} musi mieć format RRRR-MM-DD, a jest: ${JSON.stringify(value)}`);
  }
  return value;
}

export const normalize = (text) =>
  String(text ?? "").toLowerCase().replace(/[ąćęłńóśźż]/g, (c) => "acelnoszz"["ąćęłńóśźż".indexOf(c)]);

const clean = (text) => String(text ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
const timeRange = (text) => clean(text).replace(/\s*-\s*/, "–") || null;

export function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && v !== "" &&
    !(Array.isArray(v) && v.length === 0) && !(typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0)));
}

// --- sesja i cache ---------------------------------------------------------------------------

let session = null;
let rejected = null;
let createClient = () => new (require("librus-api"))();
const cache = new Map();

export function setClientFactory(factory) { // do testów
  createClient = factory;
  session = null;
  rejected = null;
  cache.clear();
}

export function clearCache() {
  cache.clear();
}

async function login() {
  loadEnv();
  const user = (process.env.LIBRUS_LOGIN || "").trim();
  const password = (process.env.LIBRUS_HASLO || "").replace(/[\r\n]+$/, ""); // wklejone w panelu Vercela bywa z Enterem
  if (!user || !password) {
    throw new Error("Brak loginu lub hasła. Uzupełnij LIBRUS_LOGIN i LIBRUS_HASLO: lokalnie w pliku .env, " +
      "na Vercelu w Settings → Environment Variables (potem Redeploy).");
  }
  // Ponawianie złego hasła kończy się CAPTCHA, więc tych samych danych nie próbujemy drugi raz.
  if (rejected && rejected.key === `${user}\n${password}`) throw new Error(`${rejected.message} Popraw LIBRUS_LOGIN / LIBRUS_HASLO.`);
  const client = createClient();
  try {
    await client.authorize(user, password);
  } catch (e) {
    const data = e?.response?.data;
    if (data && typeof data === "object" && (data.status === "error" || data.errors)) {
      const reason = (data.errors || []).map((x) => x.message || x.code).filter(Boolean).join("; ") || data.status;
      const message = `Logowanie do Librusa nieudane: ${reason}.`;
      if (data.status === "error") rejected = { key: `${user}\n${password}`, message };
      throw new Error(message);
    }
    throw new Error(`Logowanie do Librusa nieudane: ${e?.message || e}. Jeśli to chwilowe (np. przerwa techniczna), spróbuj za kilka minut.`);
  }
  session = { client, at: Date.now(), filterSet: false };
  return session;
}

let pendingLogin = null;

/** Jedno logowanie naraz: równoległe pobrania (tygodnie planu, miesiące terminarza) czekają na tę samą sesję. */
function relogin(stale) {
  if (session && session !== stale && Date.now() - session.at <= SESSION_TTL) return Promise.resolve(session);
  pendingLogin ||= login().finally(() => { pendingLogin = null; });
  return pendingLogin;
}

/** Wywołanie metody biblioteki; jeśli wynik wygląda na wygasłą sesję (`valid` zwraca false), loguje się raz od nowa. */
async function call(fn, valid = () => true) {
  let s = await relogin(null);
  let result = await fn(s.client);
  if (!valid(result)) {
    s = await relogin(s);
    result = await fn(s.client);
  }
  return result;
}

function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;
  const value = Promise.resolve().then(fn);
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

async function mapLimit(items, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return out;
}

// --- dane z biblioteki -------------------------------------------------------------------------

export function student() {
  return cached("account", async () => {
    const info = await call((c) => c.info.getAccountInfo(), (r) => Boolean(r?.student?.nameSurname || r?.account?.nameSurname));
    return compact({
      imie_nazwisko: clean(info?.student?.nameSurname || info?.account?.nameSurname),
      klasa: clean(info?.student?.class),
      wychowawca: clean(info?.student?.educator),
    });
  });
}

function splitTeacher(text) {
  const m = clean(text).match(/^(.*?)\s*\((.+)\)$/);
  return m ? { nauczyciel: m[1], grupa: m[2].replace(/^\[|\]$/g, "") } : { nauczyciel: clean(text) || null };
}

/** Plan jednego tygodnia (od poniedziałku): lista lekcji z datą i numerem lekcji. */
export function week(monday) {
  return cached(`week:${monday}`, async () => {
    const plan = await call((c) => c.calendar.getTimetable(monday, addDays(monday, 6)), (r) => r?.hours?.length > 0);
    const hours = (plan.hours || []).map(timeRange);
    const lessons = [];
    DAY_KEYS.forEach((key, i) => {
      (plan.table?.[key] || []).forEach((slot, nr) => {
        if (!slot) return;
        const original = slot.original ? { przedmiot: clean(slot.original.subject), ...splitTeacher(slot.original.teacher), sala: clean(slot.original.room) } : null;
        lessons.push({
          data: addDays(monday, i),
          nr,
          godziny: timeRange(slot.time) || hours[nr] || null,
          przedmiot: clean(slot.subject) || "Nieznany przedmiot",
          ...splitTeacher(slot.teacher),
          sala: clean(slot.room) || null,
          odwolana: Boolean(slot.cancelled),
          uwaga: clean(slot.flag) || null,
          zamiast: original ? compact(original) : null,
        });
      });
    });
    return lessons;
  });
}

function parseEvent(item) {
  const lines = String(item.title || "").replace(/ /g, " ").split("\n").map((l) => l.trim()).filter(Boolean);
  const info = String(item.info || "").replace(/ /g, " ");
  const field = (name) => clean(info.match(new RegExp(`(?:^|\\n)${name}:\\s*([^\\n]*)`))?.[1]);
  const opis = info.match(/(?:^|\n)Opis:\s*([\s\S]*?)(?:\nData dodania:|$)/)?.[1]?.trim() || null;
  const head = lines[0] || "";
  const [przedmiot, kategoria] = (() => {
    const second = lines[1] || "";
    const cut = second.lastIndexOf(", ");
    return cut > 0 ? [second.slice(0, cut), second.slice(cut + 2)] : [null, second || null];
  })();
  return compact({
    id: item.id,
    data: item.day,
    lekcja_nr: head.startsWith("Nr lekcji:") ? Number(head.split(":")[1]) : null,
    godziny: head.startsWith("Czas:") ? timeRange(head.slice(5)) : null,
    kategoria: clean(kategoria) || "Inne",
    przedmiot: clean(przedmiot),
    opis,
    grupa: lines.slice(2).filter((l) => !l.startsWith("Sala:")).map((l) => l.replace(/^\[|\]$/g, "")).join(", "),
    sala: clean(lines.find((l) => l.startsWith("Sala:"))?.slice(5)),
    nauczyciel: field("Nauczyciel"),
    dodano: field("Data dodania").slice(0, 10),
  });
}

/** Terminarz jednego miesiąca: wydarzenia (sprawdziany itd.), odwołane lekcje i dni wolne. */
export function month(year, monthNo) {
  return cached(`month:${year}-${monthNo}`, async () => {
    const raw = await call((c) => c.calendar.getCalendar(monthNo, year), Array.isArray);
    const result = { wydarzenia: [], odwolane: [], dni_wolne: [] };
    for (const item of raw.flat().filter(Boolean)) {
      const title = String(item.title || "").replace(/ /g, " ");
      if (title.startsWith("Odwołane zajęcia")) {
        const m = title.match(/\n\s*(.*?)\s+na lekcji nr:\s*(\d+)\s*\((.*)\)/);
        result.odwolane.push(compact({ data: item.day, nr: m ? Number(m[2]) : null, przedmiot: clean(m?.[3]), nauczyciel: clean(m?.[1]) }));
      } else if (item.id > 0 && !item.info && !/^(Nr lekcji|Czas):/.test(title)) {
        // Święta i dni wolne szkoły („Wszystkich Świętych: techniwaw”) – bez opisu i bez lekcji.
        result.dni_wolne.push({ data: item.day, nazwa: clean(title.replace(/:\s*[^:]*$/, "")) || clean(title) });
      } else {
        result.wydarzenia.push(parseEvent(item));
      }
    }
    return result;
  });
}

export async function months(start, end) {
  const keys = [];
  for (let d = `${start.slice(0, 7)}-01`; d <= end; d = addDays(`${d.slice(0, 7)}-28`, 4).slice(0, 7) + "-01") {
    keys.push([Number(d.slice(0, 4)), Number(d.slice(5, 7))]);
  }
  const all = await mapLimit(keys, ([y, m]) => month(y, m));
  const inRange = (x) => x.data >= start && x.data <= end;
  return {
    wydarzenia: all.flatMap((m) => m.wydarzenia).filter(inRange),
    odwolane: all.flatMap((m) => m.odwolane).filter(inRange),
    dni_wolne: all.flatMap((m) => m.dni_wolne).filter(inRange),
  };
}

/** Wszystkie lekcje z planu w zakresie dat, z oznaczeniem odwołanych (plan albo terminarz) i dni wolnych. */
export async function lessons(start, end) {
  const mondays = [];
  for (let m = mondayOf(start); m <= end; m = addDays(m, 7)) mondays.push(m);
  const [weeks, cal] = await Promise.all([mapLimit(mondays, week), months(start, end)]);
  const cancelled = new Set(cal.odwolane.map((o) => `${o.data}#${o.nr}`));
  const free = new Map(cal.dni_wolne.map((f) => [f.data, f.nazwa]));
  const list = weeks.flat().filter((l) => l.data >= start && l.data <= end).map((l) => ({
    ...l,
    odwolana: l.odwolana || cancelled.has(`${l.data}#${l.nr}`),
    dzien_wolny: free.get(l.data) || null,
  }));
  return { lessons: list, cal };
}

const lessonEnd = (l) => (l.godziny || "").split("–")[1] || "23:59";

/** Czy lekcja już się odbyła (wcześniejszy dzień albo dziś po jej końcu). */
export function isPast(lesson) {
  const now = clock.now();
  return lesson.data < now.date || (lesson.data === now.date && lessonEnd(lesson) <= now.time);
}

async function showExtracurricular(s) {
  // Strona frekwencji domyślnie ukrywa nieobecności z zajęć pozalekcyjnych (filtr „Ukryj …: TAK”).
  // Ustawiamy filtr na NIE tym samym formularzem co w przeglądarce, potem biblioteka czyta stronę jak zwykle.
  if (s.filterSet) return;
  await s.client._callerReady;
  const page = await s.client.caller.get("https://synergia.librus.pl/przegladaj_nb/uczen");
  const requestkey = String(page.data).match(/name="requestkey"\s+value="([^"]+)"/)?.[1] || "";
  await s.client.caller.postForm("https://synergia.librus.pl/przegladaj_nb/uczen", { requestkey, ukryjPozalekcyjne: "0" });
  s.filterSet = true;
}

/** Nieobecności z biblioteki: każda komórka to numer lekcji (0–10) danego dnia. */
export function absences() {
  return cached("absences", async () => {
    const raw = await call(async (c) => {
      if (config().pozalekcyjne) await showExtracurricular(session);
      return c.absence.getAbsences();
    }, (r) => r && typeof r === "object");
    const list = [];
    for (const row of Object.values(raw).flat()) {
      const data = String(row?.date || "").slice(0, 10);
      (row?.table || []).forEach((cell, nr) => {
        if (cell?.type) list.push({ id: cell.id, data, nr, skrot: cell.type, typ: TYPY[cell.type] || cell.type, obecnosc: !NIEOBECNE.has(cell.type) });
      });
    }
    return list;
  });
}

/** Przedmiot nieobecności z jej szczegółów (gdy nie ma jej w planie, np. lekcja dodatkowa). */
export function absenceSubject(id) {
  return cached(`absence:${id}`, async () => clean((await call((c) => c.absence.getAbsence(id)))?.subject) || null);
}

export function grades() {
  return cached("grades", () => call((c) => c.info.getGrades(), (r) => Array.isArray(r) && r.length > 0));
}
