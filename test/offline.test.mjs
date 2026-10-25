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

// API JSON Librusa (gateway), czytane klientem HTTP biblioteki.
const gw = (id, lesson, type, date, no, sem = 1) => ({ Id: id, Lesson: { Id: lesson }, Type: { Id: type }, Date: date, LessonNo: String(no), Semester: sem });
const GATEWAY = {
  Me: { Me: { Class: { Id: 5 } } },
  "Classes/5": { Class: { EndFirstSemester: "2027-01-15", EndSchoolYear: "2027-06-25" } },
  Subjects: { Subjects: [{ Id: 1, Name: "Matematyka" }, { Id: 2, Name: "Język polski" }, { Id: 3, Name: "Przygotowanie do egzaminu INF.04." }] },
  Lessons: { Lessons: [{ Id: 10, Subject: { Id: 1 } }, { Id: 20, Subject: { Id: "2" } }] },
  "Lessons/30": { Lesson: { Id: 30, Subject: { Id: 3 } } },
  "Attendances/Types": { Types: [
    { Id: 1, Name: "Nieobecność", Short: "nb", IsPresenceKind: false },
    { Id: 2, Name: "Spóźnienie", Short: "sp", IsPresenceKind: true },
    { Id: 3, Name: "Nieobecność uspr.", Short: "u", IsPresenceKind: false },
    { Id: 100, Name: "Obecność", Short: "ob", IsPresenceKind: true },
  ] },
  Attendances: { Attendances: [
    ...["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-14"].map((d, i) => gw(100 + i, 10, 100, d, 1)),
    gw(110, 10, 2, "2026-09-15", 1),
    ...["2026-10-19", "2026-10-20", "2026-10-21"].map((d, i) => gw(120 + i, 10, 1, d, 1)),
    gw(200, 20, 100, "2026-09-07", 3), gw(201, 20, 100, "2026-09-08", 3),
    ...["2026-09-09", "2026-09-10", "2026-09-11"].map((d, i) => gw(210 + i, 20, 3, d, 3)),
    gw(300, 30, 1, "2026-10-12", 5), // zajęcia pozalekcyjne: w API są, na stronie frekwencji ukryte
    gw(400, 10, 100, "2027-02-01", 1, 2),
  ] },
};

let calls;
let expireNextTimetable;
let loginError;
let gatewayMode;
function fakeClient() {
  return {
    _callerReady: Promise.resolve(),
    caller: {
      get: async (url) => {
        const path = url.replace("https://synergia.librus.pl/gateway/api/2.0/", "");
        calls.gateway.push(path);
        if (gatewayMode === "down") return { status: 403, data: { Status: "Error", Message: "Request is denied" } };
        if (gatewayMode === "expire-once") { gatewayMode = "ok"; return { status: 401, data: {} }; }
        if (gatewayMode === "no-attendance" && path === "Attendances") return { status: 403, data: {} };
        return GATEWAY[path] ? { status: 200, data: GATEWAY[path] } : { status: 404, data: {} };
      },
    },
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
  calls = { authorize: 0, timetable: [], calendar: [], absenceDetail: [], gateway: [] };
  expireNextTimetable = false;
  loginError = null;
  gatewayMode = "down"; // testy liczenia z planu; testy API przełączają na "ok"
  process.env.LIBRUS_LOGIN = "1234567u";
  process.env.LIBRUS_HASLO = "test";
  L.setClientFactory(fakeClient);
  L.clock.now = () => ({ date: "2026-10-21", time: "12:00" });
});

test("frekwencja z API: wpisy jak u wychowawcy, z obecnościami i zajęciami pozalekcyjnymi", async () => {
  gatewayMode = "ok";
  const f = await frekwencja();
  const by = Object.fromEntries(f.przedmioty.map((p) => [p.przedmiot, p]));
  assert.equal(f.zrodlo, "wpisy frekwencji z Librusa");
  assert.deepEqual(f.zakres, { semestr: 1, od: "2026-09-01", do: "2026-10-21" });
  assert.deepEqual([f.ogolem.lekcje, f.ogolem.obecnosci, f.ogolem.frekwencja_proc], [16, 9, 56.25]);
  assert.deepEqual([by.Matematyka.lekcje, by.Matematyka.obecnosci, by.Matematyka.frekwencja_proc], [10, 7, 70]);
  assert.deepEqual(by.Matematyka.wg_typu, { "Obecność": 6, "Nieobecność": 3, "Spóźnienie": 1 });
  assert.deepEqual([by["Język polski"].obecnosci_do_progu, by["Język polski"].ponizej_progu], [1, true]); // 2/5
  assert.deepEqual([by["Przygotowanie do egzaminu INF.04."].lekcje, by["Przygotowanie do egzaminu INF.04."].obecnosci], [1, 0]);
  assert.deepEqual(calls.gateway.filter((p) => p.startsWith("Lessons/")), ["Lessons/30"]); // lekcja spoza listy, raz
  assert.equal((await frekwencja({ semestr: 0 })).ogolem.lekcje, 17);
  assert.equal((await frekwencja({ semestr: 2 })).ogolem.lekcje, 1);
  assert.equal((await frekwencja({ od: "2026-10-01" })).ogolem.lekcje, 4);
  assert.equal(calls.authorize, 1);
  assert.equal(calls.timetable.length, 1); // tylko bieżący tydzień, dla godzin lekcji
  assert.equal((await doKoncaSemestru()).koniec, "2027-01-15");                         // data z klasy w API wygrywa z config.json
});

test("nieobecności z API: przedmiot i typ z wpisu, godziny z planu", async () => {
  gatewayMode = "ok";
  const n = await nieobecnosci();
  assert.equal(n.liczba, 8);
  assert.deepEqual(n.wpisy[0], { data: "2026-09-09", dzien: "środa", lekcja_nr: 3, godziny: "10:35–11:20", przedmiot: "Język polski",
    typ: "Nieobecność uspr.", skrot: "u", obecnosc: false });
  assert.equal((await nieobecnosci({ typ: "nb" })).liczba, 4);
  assert.equal((await nieobecnosci({ przedmiot: "inf" })).wpisy[0].godziny, undefined); // lekcja 5 nie ma godzin w planie
});

test("API: wygasła sesja (401) – jedno ponowne logowanie; brak frekwencji w API – plan jako zapas", async () => {
  gatewayMode = "expire-once";
  assert.equal((await frekwencja()).ogolem.lekcje, 16);
  assert.equal(calls.authorize, 2);
  L.setClientFactory(fakeClient);
  gatewayMode = "no-attendance";
  const f = await frekwencja();
  assert.equal(f.zrodlo, "plan lekcji (zapasowo)");
  assert.match(f.uwaga, /niedostępne \(API Librusa odrzuciło Attendances \(HTTP 403\)\)/);
  assert.equal(f.ogolem.lekcje, 63);
});

test("frekwencja zapasowo z planu: lekcje z planu minus odwołane i dni wolne, nieobecności po dacie i numerze lekcji", async () => {
  const f = await frekwencja();
  assert.equal(f.zrodlo, "plan lekcji (zapasowo)");
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
