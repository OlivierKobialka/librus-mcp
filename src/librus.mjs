// Dostęp do Librus Synergia przez bibliotekę librus-api (Mati365): logowanie, cache i dane w prostej postaci.
// Plan, terminarz, oceny i nieobecności czyta biblioteka (strony HTML Synergii). Wpisy frekwencji i daty semestru
// bierzemy z API JSON Librusa przez tę samą, zalogowaną biblioteką sesję: strona frekwencji nie pokazuje obecności.
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
const GATEWAY = "https://synergia.librus.pl/gateway/api/2.0";
const MAX_LESSON_LOOKUPS = 60; // lekcje spoza listy Lessons dociągamy pojedynczo, więc z limitem

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

function configFile() {
  const path = new URL("config.json", ROOT);
  return fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
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

/** Daty semestrów: zmienne środowiskowe, potem klasa z API Librusa, potem config.json, na końcu typowe daty. */
export function semesterDates() {
  return cached("semester-dates", async () => {
    const year = Number(schoolYearStart().slice(0, 4));
    const file = configFile();
    let api = {};
    if (!process.env.KONIEC_1_SEMESTRU || !process.env.KONIEC_ROKU) {
      try {
        const classId = (await gateway("Me"))?.Me?.Class?.Id;
        const cls = classId ? (await gateway(`Classes/${classId}`))?.Class : null;
        api = { koniec1: cls?.EndFirstSemester?.slice(0, 10), koniecRoku: cls?.EndSchoolYear?.slice(0, 10) };
      } catch (e) {
        if (!(e instanceof GatewayError)) throw e;
      }
    }
    return {
      koniec1: process.env.KONIEC_1_SEMESTRU || api.koniec1 || file.koniec_1_semestru || lastWeekday(`${year + 1}-01-31`, 4),
      koniecRoku: process.env.KONIEC_ROKU || api.koniecRoku || file.koniec_roku || lastWeekday(`${year + 1}-06-30`, 4),
    };
  });
}

export async function semesterRange(semestr) {
  const { koniec1, koniecRoku } = await semesterDates();
  return semestr === 2 ? [addDays(koniec1, 1), koniecRoku] : semestr === 0 ? [schoolYearStart(), koniecRoku] : [schoolYearStart(), koniec1];
}

export async function currentSemester() {
  return today() <= (await semesterDates()).koniec1 ? 1 : 2;
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
  session = { client, at: Date.now() };
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

/** Nieobecności z biblioteki: każda komórka to numer lekcji (0–10) danego dnia.
 * Strona Librusa domyślnie ukrywa tu zajęcia pozalekcyjne; wpisy z API (attendanceRecords) je mają. */
export function absences() {
  return cached("absences", async () => {
    const raw = await call((c) => c.absence.getAbsences(), (r) => r && typeof r === "object");
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

// --- API JSON Librusa przez sesję biblioteki -------------------------------------------------

export class GatewayError extends Error {}

const toInt = (value) => (value === null || value === undefined || value === "" || Number.isNaN(Number(value)) ? null : Number(value));

/** GET na API Synergii klientem HTTP biblioteki (te same ciasteczka sesji); przy 401 jedno ponowne logowanie. */
export async function gateway(path) {
  const get = async (s) => {
    await s.client._callerReady;
    return s.client.caller.get(`${GATEWAY}/${path}`, { headers: { Accept: "application/json" }, validateStatus: () => true });
  };
  let s = await relogin(null);
  let r = await get(s);
  if (r.status === 401) {
    s = await relogin(s);
    r = await get(s);
  }
  if (r.status !== 200 || !r.data || typeof r.data !== "object") {
    throw new GatewayError(`API Librusa odrzuciło ${path} (HTTP ${r.status})`);
  }
  return r.data;
}

/** Wszystkie wpisy frekwencji (obecności też) z przedmiotem, typem i semestrem – to samo, co widzi wychowawca. */
export function attendanceRecords() {
  return cached("gw:attendance", async () => {
    const [types, subjects, lessonList, records] = await Promise.all(
      ["Attendances/Types", "Subjects", "Lessons", "Attendances"].map((p) => gateway(p)),
    );
    const typeById = new Map((types.Types || []).map((t) => [toInt(t.Id), t]));
    const subjectById = new Map((subjects.Subjects || []).map((s) => [toInt(s.Id), clean(s.Name)]));
    const lessonSubject = new Map((lessonList.Lessons || []).map((l) => [toInt(l.Id), toInt(l.Subject?.Id)]));
    const attendances = records.Attendances || [];
    const missing = [...new Set(attendances.map((a) => toInt(a.Lesson?.Id)))]
      .filter((id) => id !== null && !lessonSubject.has(id)).slice(0, MAX_LESSON_LOOKUPS);
    await mapLimit(missing, async (id) => {
      try {
        lessonSubject.set(id, toInt((await gateway(`Lessons/${id}`))?.Lesson?.Subject?.Id));
      } catch (e) {
        if (!(e instanceof GatewayError)) throw e;
      }
    });
    return attendances.map((a) => {
      const type = typeById.get(toInt(a.Type?.Id)) || {};
      return {
        data: String(a.Date || "").slice(0, 10),
        nr: toInt(a.LessonNo),
        przedmiot: subjectById.get(lessonSubject.get(toInt(a.Lesson?.Id))) || "Nieznany przedmiot",
        typ: clean(type.Name) || "?",
        skrot: clean(type.Short) || "?",
        obecnosc: Boolean(type.IsPresenceKind),
        semestr: toInt(a.Semester),
      };
    });
  });
}

/** Godziny lekcji po numerze, z planu bieżącego tygodnia (do opisu wpisów frekwencji). */
export async function lessonHours() {
  try {
    return new Map((await week(mondayOf(today()))).map((l) => [l.nr, l.godziny]));
  } catch {
    return new Map();
  }
}
