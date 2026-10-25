// Testy bez sieci: udawany klient librus-api z danymi w kształcie, jaki zwraca biblioteka.
// Uruchom w kopii projektu bez .env:  node --test
import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import * as L from "../src/librus.mjs";
import { doKoncaSemestru, frekwencja, gradeValue, nieobecnosci, oceny, planLekcji, terminarz } from "../src/tools.mjs";

const HOURS = ["08:00 - 08:45", "08:50 - 09:35", "09:40 - 10:25", "10:35 - 11:20", "11:25 - 12:10",
  "12:35 - 13:20", "13:45 - 14:30", "14:35 - 15:20", "15:25 - 16:10", "16:15 - 17:00", "17:05 - 17:50"];
const lesson = (subject, nr, extra = {}) => ({ subject, teacher: `${subject.split(" ")[0]} Nauczyciel ([22/23 gr. II])`, room: "S1",
  time: HOURS[nr].replace(/ /g, " "), cancelled: false, flag: null, original: null, ...extra });
const day = (...lessons) => {
  const row = Array(11).fill(null);
  for (const l of lessons) row[HOURS.findIndex((h) => h.replace(/ /g, " ") === l.time)] = l;
  return row;
};
function plan(monday) {
  const table = {
    Monday: day(lesson("Matematyka", 1), lesson("Matematyka", 2), lesson("Język polski", 3)),
    Tuesday: day(lesson("Język polski", 1)),
    Wednesday: day(lesson("Matematyka", 1), lesson("Fizyka", 2), lesson("Język angielski", 6)),
    Thursday: day(lesson("Fizyka", 1)),
    Friday: day(lesson("Fizyka", 1)),
    Saturday: day(), Sunday: day(),
  };
  if (monday === "2026-10-19") { // zastępstwo: historia zamiast polskiego
    table.Tuesday[1] = { ...lesson("Historia", 1), flag: "zastępstwo", original: lesson("Język polski", 1) };
  }
  if (monday === "2026-10-26") table.Monday[2] = { ...lesson("Matematyka", 2), cancelled: true, flag: "odwołane" };
  return { hours: HOURS, table };
}
const CALENDAR = {
  "9/2026": [[{ id: -1, day: "2026-09-07", title: "Odwołane zajęcia \nJan Nowak na lekcji nr: 1 (Matematyka)" }]],
  "10/2026": [
    [{ id: 1161355, day: "2026-10-14", title: "Dzień Edukacji Narodowej- dzień wolny od zajęć dydaktycznych: techniwaw" }],
    [{ id: 10, day: "2026-10-22", title: "Nr lekcji: 1\nFizyka, Sprawdzian\n[22/23 gr 2]",
      info: "Nauczyciel: Kowalski Jan\nOpis: Kinematyka\nData dodania: 2026-10-10 12:00:00" },
    { id: 11, day: "2026-10-23", title: "Czas: 09:00 - 12:00\nJęzyk polski, Wycieczka\n5a techniwaw\nSala: S10",
      info: "Nauczyciel: Nowak Anna\nOpis: Kino\n\nLalka\nData dodania: 2026-10-01 10:00:00" }],
  ],
  "11/2026": [[{ id: 1161308, day: "2026-11-11", title: "Święto Niepodległości: techniwaw" }]],
};
const ABSENCES = { 0: [
  { date: "2026-10-21 (śr.)", table: [null, { type: "nb", id: 1 }, { type: "sp", id: 2 }, ...Array(8).fill(null)], info: [] },
  { date: "2026-10-20 (wt.)", table: [null, { type: "u", id: 3 }, ...Array(9).fill(null)], info: [] },
  { date: "2026-10-17 (sob.)", table: [null, { type: "nb", id: 5 }, ...Array(9).fill(null)], info: [] },
  { date: "2026-09-07 (pon.)", table: [null, null, null, { type: "nb", id: 4 }, ...Array(7).fill(null)], info: [] },
] };
const GRADES = [
  { name: "Matematyka", semester: [{ grades: [
    { id: 1, value: "5", info: "Kategoria: sprawdzian\nData: 2026-10-01 (czw.)\nNauczyciel: X\nLicz do średniej: tak\nWaga: 3\n" },
    { id: 2, value: "4+", info: "Kategoria: kartkówka\nData: 2026-10-02 (pt.)\nLicz do średniej: tak\nWaga: 1\n" },
    { id: 3, value: "np", info: "Kategoria: praca\nData: 2026-10-03 (sob.)\nLicz do średniej: nie\n" },
  ], average: NaN }, { grades: [] }, { grades: [] }, { grades: [] }] },
  { name: "Geografia", semester: [{ grades: [] }, { grades: [] }, { grades: [] }, { grades: [] }] },
  { name: "Język polski", semester: [{ grades: [
    { id: 4, value: "T", info: "Ocena: Brak wypracowania.\nKategoria: wypracowanie\nData: 2026-09-15 (wt.)\n" },
    { id: 5, value: "1", info: "Kategoria: sprawdzian\nData: 2026-10-06 (wt.)\nLicz do średniej: tak\nWaga: 1\n\nKomentarz: 4%, lektura" },
  ] }, { grades: [] }, { grades: [] }, { grades: [] }] },
];

let calls;
let expireNextTimetable;
let loginError;
function fakeClient() {
  return {
    authorize: async () => { calls.authorize++; if (loginError) throw loginError; },
    info: {
      getAccountInfo: async () => ({ student: { nameSurname: "Jan Test", class: "5 a techniwaw", educator: "Nowak Anna" } }),
      getGrades: async () => GRADES,
    },
    absence: {
      getAbsences: async () => ABSENCES,
      getAbsence: async (id) => { calls.absenceDetail.push(id); return { subject: "Zajęcia dodatkowe" }; },
    },
    calendar: {
      getTimetable: async (from) => {
        calls.timetable.push(from);
        if (expireNextTimetable) { expireNextTimetable = false; return { hours: [], table: {} }; }
        return plan(from);
      },
      getCalendar: async (month, year) => { calls.calendar.push(`${month}/${year}`); return CALENDAR[`${month}/${year}`] || []; },
    },
  };
}

beforeEach(() => {
  calls = { authorize: 0, timetable: [], calendar: [], absenceDetail: [] };
  expireNextTimetable = false;
  loginError = null;
  process.env.LIBRUS_LOGIN = "1234567u";
  process.env.LIBRUS_HASLO = "test";
  L.setClientFactory(fakeClient);
  L.clock.now = () => ({ date: "2026-10-21", time: "12:00" });
});

test("frekwencja: lekcje z planu minus odwołane i dni wolne, nieobecności po dacie i numerze lekcji", async () => {
  const f = await frekwencja();
  const by = Object.fromEntries(f.przedmioty.map((p) => [p.przedmiot, p]));
  assert.deepEqual(f.uczen, { imie_nazwisko: "Jan Test", klasa: "5 a techniwaw", wychowawca: "Nowak Anna" });
  assert.deepEqual(f.zakres, { semestr: 1, od: "2026-09-01", do: "2026-10-21" });
  assert.equal(f.ogolem.lekcje, 63);
  assert.equal(f.ogolem.obecnosci, 59);
  assert.equal(f.ogolem.frekwencja_proc, 93.65);
  assert.deepEqual([by.Matematyka.lekcje, by.Matematyka.obecnosci], [20, 19]);       // 7 pon × 2 − odwołana + 7 śr
  assert.deepEqual([by["Język polski"].lekcje, by["Język polski"].obecnosci], [14, 13]); // wtorek 20.10 to zastępstwo
  assert.deepEqual([by.Fizyka.lekcje, by.Fizyka.obecnosci], [21, 21]);                 // spóźnienie = obecność
  assert.deepEqual(by.Fizyka.wg_typu, { "obecność": 20, "spóźnienie": 1 });
  assert.equal(by["Język angielski"].lekcje, 6);                                       // dzisiejsza 13:45 jeszcze się nie odbyła
  assert.deepEqual([by.Historia.lekcje, by.Historia.obecnosci, by.Historia.obecnosci_do_progu, by.Historia.ponizej_progu], [1, 0, 1, true]);
  assert.equal(by["Zajęcia dodatkowe"].lekcje, 1);                                     // sobota spoza planu, przedmiot ze szczegółów
  assert.deepEqual(calls.absenceDetail, [5]);
  assert.match(f.uwaga, /pozalekcyjnych są ukryte/);
  assert.equal((await frekwencja({ przedmiot: "jezyk" })).ogolem.lekcje, 20);           // polski + angielski, bez polskich znaków
  assert.equal((await frekwencja({ semestr: 2 })).ogolem.lekcje, 0);
  assert.equal(calls.authorize, 1);                                                    // jedna sesja, reszta z cache
});

test("do końca semestru: pozostałe lekcje z planu bez odwołanych", async () => {
  const p = await doKoncaSemestru({ koniec: "2026-10-30" });
  const by = Object.fromEntries(p.przedmioty.map((x) => [x.przedmiot, x]));
  assert.equal(p.ogolem.zostalo_lekcji, 11);
  assert.deepEqual([by.Matematyka.zostalo_lekcji, by.Matematyka.zdazysz, by.Matematyka.mozna_opuscic_do_konca], [2, true, 2]);
  assert.deepEqual([by.Fizyka.zostalo_lekcji, by["Język angielski"].zostalo_lekcji, by["Język polski"].zostalo_lekcji], [5, 2, 2]);
  assert.deepEqual([by.Historia.zostalo_lekcji, by.Historia.zdazysz, by.Historia.max_frekwencja_na_koniec_proc], [0, false, 0]);
  assert.equal((await doKoncaSemestru()).koniec, "2027-01-22");                        // z config.json
});

test("plan lekcji: godziny, nauczyciel z grupą, zastępstwo, odwołanie, sprawdziany i dni wolne", async () => {
  const p = await planLekcji();
  assert.deepEqual([p.od, p.do], ["2026-10-19", "2026-10-23"]);
  const byDate = Object.fromEntries(p.dni.map((d) => [d.data, d]));
  assert.deepEqual(byDate["2026-10-19"].lekcje[0], { nr: 1, godziny: "08:50–09:35", przedmiot: "Matematyka", nauczyciel: "Matematyka Nauczyciel",
    grupa: "22/23 gr. II", sala: "S1" });
  assert.deepEqual(byDate["2026-10-20"].lekcje[0].zamiast, { przedmiot: "Język polski", nauczyciel: "Język Nauczyciel", grupa: "22/23 gr. II", sala: "S1" });
  assert.equal(byDate["2026-10-20"].lekcje[0].zastepstwo, true);
  assert.deepEqual(byDate["2026-10-22"].wydarzenia, [{ lekcja_nr: 1, kategoria: "Sprawdzian", przedmiot: "Fizyka", opis: "Kinematyka" }]);
  L.clock.now = () => ({ date: "2026-10-24", time: "10:00" });                          // sobota -> następny tydzień
  const next = await planLekcji();
  assert.deepEqual([next.od, next.do], ["2026-10-26", "2026-10-30"]);
  assert.equal(next.dni[0].lekcje[1].odwolana, true);
  const holiday = await planLekcji({ od: "2026-10-12", do: "2026-10-16" });
  assert.equal(holiday.dni.find((d) => d.data === "2026-10-14").dzien_wolny, "Dzień Edukacji Narodowej- dzień wolny od zajęć dydaktycznych");
  await assert.rejects(planLekcji({ od: "2026-10-23", do: "2026-10-19" }), /wcześniejsza/);
  await assert.rejects(planLekcji({ od: "2026-10-01", do: "2026-12-01" }), /Za długi zakres/);
  await assert.rejects(planLekcji({ od: "23.10.2026" }), /RRRR-MM-DD/);
});

test("terminarz: wydarzenia z kategorią, odwołane lekcje i dni wolne", async () => {
  const t = await terminarz();
  assert.deepEqual([t.od, t.do, t.liczba], ["2026-10-21", "2026-11-04", 2]);
  assert.deepEqual(t.wydarzenia[1], { data: "2026-10-23", godziny: "09:00–12:00", kategoria: "Wycieczka", przedmiot: "Język polski",
    opis: "Kino\n\nLalka", grupa: "5a techniwaw", sala: "S10", nauczyciel: "Nowak Anna", dodano: "2026-10-01", dzien: "piątek" });
  assert.equal((await terminarz({ kategoria: "spraw" })).liczba, 1);
  const longer = await terminarz({ od: "2026-09-01", do: "2026-11-30" });
  assert.deepEqual(longer.dni_wolne.map((d) => d.nazwa), ["Dzień Edukacji Narodowej- dzień wolny od zajęć dydaktycznych", "Święto Niepodległości"]);
  assert.deepEqual(longer.odwolane_lekcje, [{ data: "2026-09-07", nr: 1, przedmiot: "Matematyka", nauczyciel: "Jan Nowak" }]);
});

test("nieobecności: przedmiot z planu, typy i filtry", async () => {
  const n = await nieobecnosci();
  assert.equal(n.liczba, 5);
  assert.deepEqual(n.wpisy[0], { data: "2026-09-07", dzien: "poniedziałek", lekcja_nr: 3, godziny: "10:35–11:20", przedmiot: "Język polski",
    typ: "nieobecność", skrot: "nb", obecnosc: false });
  assert.equal((await nieobecnosci({ typ: "nb" })).liczba, 3);
  assert.equal((await nieobecnosci({ typ: "spóźnienie" })).liczba, 1);
  assert.equal((await nieobecnosci({ od: "2026-10-20" })).liczba, 3);
});

test("oceny: opis z biblioteki rozbity na pola, średnia ważona jak w Librusie", async () => {
  const g = await oceny();
  assert.deepEqual(g.przedmioty.map((p) => p.przedmiot), ["Matematyka", "Język polski"]);
  assert.equal(g.przedmioty[0].semestr_1.srednia_wazona, 4.88);                        // (5·3 + 4,5·1) / 4
  assert.deepEqual(g.przedmioty[0].semestr_1.oceny[2], { ocena: "np", kategoria: "praca", data: "2026-10-03", do_sredniej: false });
  assert.deepEqual(g.przedmioty[1].semestr_1.oceny[1], { ocena: "1", kategoria: "sprawdzian", data: "2026-10-06", waga: 1, do_sredniej: true,
    komentarz: "4%, lektura" });
  assert.deepEqual([gradeValue("3-"), gradeValue("+"), gradeValue("6")], [2.75, null, 6]);
  assert.equal((await oceny({ semestr: 2 })).przedmioty.length, 0);
});

test("sesja: pusty plan oznacza wygasłą sesję – jedno ponowne logowanie", async () => {
  expireNextTimetable = true;
  const p = await planLekcji({ od: "2026-10-19", do: "2026-10-19" });
  assert.equal(p.dni[0].lekcje.length, 3);
  assert.equal(calls.authorize, 2);
});

test("logowanie: złe hasło nie jest ponawiane, brak danych daje czytelny błąd", async () => {
  loginError = Object.assign(new Error("Request failed with status code 403"),
    { response: { data: { status: "error", errors: [{ message: "Nieprawidłowy login i/lub hasło." }] } } });
  await assert.rejects(planLekcji(), /Nieprawidłowy login/);
  await assert.rejects(oceny(), /Popraw LIBRUS_LOGIN/);
  assert.equal(calls.authorize, 1);
  L.setClientFactory(fakeClient);
  delete process.env.LIBRUS_LOGIN;
  await assert.rejects(oceny(), /Brak loginu lub hasła/);
});
