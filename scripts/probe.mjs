// Jednorazowa diagnostyka: loguje się przez librus-api i zapisuje do debug/ surowe wyniki jej metod,
// żeby narzędzia MCP dało się dopasować do tego, co biblioteka faktycznie zwraca na tym koncie.
// Uruchom: node scripts/probe.mjs   (dane logowania z pliku .env obok package.json)
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Librus = require("librus-api");
const root = new URL("../", import.meta.url);
const debug = new URL("debug/", root);
fs.mkdirSync(debug, { recursive: true });

const env = Object.fromEntries(
  fs.readFileSync(new URL(".env", root), "utf8").split(/\r?\n/)
    .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
    .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()]),
);
if (!env.LIBRUS_LOGIN || !env.LIBRUS_HASLO) throw new Error("Brak LIBRUS_LOGIN / LIBRUS_HASLO w .env");

const iso = (d) => d.toISOString().slice(0, 10);
const monday = new Date();
monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

const client = new Librus();
const started = Date.now();
await client.authorize(env.LIBRUS_LOGIN, env.LIBRUS_HASLO);
console.log(`authorize: OK (${Date.now() - started} ms)`);

const results = {};
async function run(name, fn) {
  const t = Date.now();
  try {
    results[name] = await fn();
    const size = JSON.stringify(results[name] ?? null).length;
    console.log(`${name}: OK (${Date.now() - t} ms, ${size} znaków)`);
  } catch (e) {
    results[name] = { error: String(e?.stack || e) };
    console.log(`${name}: BŁĄD ${e?.message || e}`);
  }
  fs.writeFileSync(new URL(`${name}.json`, debug), JSON.stringify(results[name], null, 1));
}

await run("getAccountInfo", () => client.info.getAccountInfo());
await run("getLuckyNumber", () => client.info.getLuckyNumber());
await run("getGrades", () => client.info.getGrades());
await run("getAbsences", () => client.absence.getAbsences());
const firstAbsence = Object.values(results.getAbsences || {}).flat()
  .flatMap((day) => day?.table || []).find((cell) => cell && cell.id > 0);
if (firstAbsence) await run("getAbsence", () => client.absence.getAbsence(firstAbsence.id));
await run("getTimetable_ten_tydzien", () => client.calendar.getTimetable(iso(monday), iso(addDays(monday, 6))));
await run("getTimetable_przyszly", () => client.calendar.getTimetable(iso(addDays(monday, 7)), iso(addDays(monday, 13))));
await run("getTimetable_wrzesien", () => client.calendar.getTimetable("2026-09-07", "2026-09-13"));
const now = new Date();
await run("getCalendar", () => client.calendar.getCalendar(now.getMonth() + 1, now.getFullYear()));
await run("getCalendar_nastepny", () => client.calendar.getCalendar(((now.getMonth() + 1) % 12) + 1, now.getFullYear() + (now.getMonth() === 11 ? 1 : 0)));
const firstEvent = (results.getCalendar || []).flat?.().find((e) => e && e.id > 0);
if (firstEvent) await run("getEvent", () => client.calendar.getEvent(firstEvent.id));
await run("listHomeworkSubjects", () => client.homework.listSubjects());

// Surowy HTML strony frekwencji: biblioteka czyta z niej tylko część pól, sprawdzimy, co jeszcze tam jest.
await run("przegladaj_nb_html", async () => {
  await client._callerReady;
  return (await client.caller.get("https://synergia.librus.pl/przegladaj_nb/uczen")).data;
});
console.log(`\nGotowe w ${Math.round((Date.now() - started) / 1000)} s. Wyniki są w folderze debug/.`);
