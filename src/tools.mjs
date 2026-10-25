// Narzędzia MCP na danych z librus-api; ten sam serwer działa lokalnie (stdio) i na Vercelu (HTTP).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as L from "./librus.mjs";

const MAX_ABSENCE_DETAILS = 40; // nieobecności spoza planu dociągamy pojedynczo, więc z limitem

// --- frekwencja --------------------------------------------------------------------------------

function attendanceStats(rows, prog) {
  const total = rows.length;
  const present = rows.filter((r) => r.obecnosc).length;
  const byType = {};
  for (const r of rows) byType[r.typ] = (byType[r.typ] || 0) + 1;
  const stats = {
    lekcje: total,
    obecnosci: present,
    nieobecnosci: total - present,
    frekwencja_proc: total ? Math.round((10000 * present) / total) / 100 : null,
    wg_typu: Object.fromEntries(Object.entries(byType).sort((a, b) => b[1] - a[1])),
  };
  if (total) {
    const spare = Math.floor((present * 100) / prog - total + 1e-9);
    stats.mozna_jeszcze_opuscic = Math.max(spare, 0);
    // Ile lekcji z rzędu trzeba być obecnym, żeby (obecności + n) / (lekcje + n) >= próg.
    stats.obecnosci_do_progu = 0;
    if (spare < 0) {
      stats.ponizej_progu = true;
      stats.obecnosci_do_progu = prog < 100 ? Math.ceil((prog * total - 100 * present) / (100 - prog) - 1e-9) : null;
    }
  }
  return stats;
}

const matches = (filter, name) => !filter || L.normalize(name).includes(L.normalize(filter));

/** Lekcje, które już się odbyły (plan bez odwołanych i dni wolnych), z nałożonymi nieobecnościami. */
async function attendanceRows({ semestr, od, do: to, przedmiot }) {
  const sem = semestr ?? L.currentSemester();
  const [semStart, semEnd] = sem === 0 ? [L.schoolYearStart(), L.config().koniecRoku] : L.semesterRange(sem);
  const start = L.checkDate(od, "od") || semStart;
  const requestedEnd = L.checkDate(to, "do") || semEnd;
  const end = requestedEnd < L.today() ? requestedEnd : L.today();
  if (start > end) return { sem, start, end: requestedEnd, rows: [] };

  const [{ lessons }, absences] = await Promise.all([L.lessons(start, end), L.absences()]);
  const anyLesson = new Map(lessons.map((l) => [`${l.data}#${l.nr}`, l]));
  const rows = new Map(
    lessons.filter((l) => !l.odwolana && !l.dzien_wolny && L.isPast(l)).map((l) => [`${l.data}#${l.nr}`, {
      data: l.data, dzien: L.DNI[L.weekday(l.data)], lekcja_nr: l.nr, godziny: l.godziny, przedmiot: l.przedmiot,
      typ: "obecność", skrot: "ob", obecnosc: true,
    }]),
  );
  let details = 0;
  for (const a of absences.filter((a) => a.data >= start && a.data <= end)) {
    const key = `${a.data}#${a.nr}`;
    let row = rows.get(key);
    if (!row) { // wpis frekwencji na lekcji, której nie ma w planie (np. zastępstwo, zajęcia dodatkowe)
      let subject = anyLesson.get(key)?.przedmiot;
      if (!subject && details++ < MAX_ABSENCE_DETAILS) subject = await L.absenceSubject(a.id);
      row = { data: a.data, dzien: L.DNI[L.weekday(a.data)], lekcja_nr: a.nr, godziny: anyLesson.get(key)?.godziny ?? null,
        przedmiot: subject || "Nieznany przedmiot" };
      rows.set(key, row);
    }
    Object.assign(row, { typ: a.typ, skrot: a.skrot, obecnosc: a.obecnosc });
  }
  const list = [...rows.values()]
    .filter((r) => matches(przedmiot, r.przedmiot))
    .sort((a, b) => a.data.localeCompare(b.data) || a.lekcja_nr - b.lekcja_nr);
  return { sem, start, end, rows: list };
}

function groupBy(rows, key) {
  const groups = new Map();
  for (const r of rows) groups.set(r[key], [...(groups.get(r[key]) || []), r]);
  return [...groups.entries()].sort((a, b) => L.normalize(a[0]).localeCompare(L.normalize(b[0])));
}

function attendanceNote() {
  return "Liczba lekcji to lekcje z planu Librusa, które już się odbyły (bez odwołanych i dni wolnych); " +
    "spóźnienie i zwolnienie liczą się jako obecność." +
    (L.config().pozalekcyjne ? "" : " Nieobecności z zajęć pozalekcyjnych są ukryte przez filtr Librusa.");
}

export async function frekwencja({ semestr, od, do: to, przedmiot, prog = 50 } = {}) {
  if (!(prog > 0 && prog <= 100)) throw new Error("prog musi być z przedziału (0, 100].");
  const { sem, start, end, rows } = await attendanceRows({ semestr, od, do: to, przedmiot });
  return {
    uczen: await L.student(),
    zakres: L.compact({ semestr: sem || "cały rok", od: start, do: end, przedmiot }),
    prog_proc: prog,
    ogolem: attendanceStats(rows, prog),
    przedmioty: groupBy(rows, "przedmiot").map(([name, list]) => ({ przedmiot: name, ...attendanceStats(list, prog) })),
    uwaga: attendanceNote(),
  };
}

function forecast(rows, left, prog) {
  const stats = attendanceStats(rows, prog);
  const { obecnosci: present, lekcje: total } = stats;
  // Ile z pozostałych lekcji można opuścić, żeby na koniec mieć (obecności + zostało - x) / (lekcje + zostało) >= próg.
  const allowed = Math.floor(present + left - (prog * (total + left)) / 100 + 1e-9);
  return {
    lekcje: total,
    obecnosci: present,
    frekwencja_proc: stats.frekwencja_proc,
    zostalo_lekcji: left,
    obecnosci_do_progu: stats.obecnosci_do_progu ?? 0,
    zdazysz: allowed >= 0,
    mozna_opuscic_do_konca: Math.min(Math.max(allowed, 0), left),
    max_frekwencja_na_koniec_proc: total + left ? Math.round((10000 * (present + left)) / (total + left)) / 100 : null,
  };
}

export async function doKoncaSemestru({ prog = 50, przedmiot, koniec } = {}) {
  if (!(prog > 0 && prog <= 100)) throw new Error("prog musi być z przedziału (0, 100].");
  const sem = L.currentSemester();
  const end = L.checkDate(koniec, "koniec") || L.semesterRange(sem)[1];
  const [{ rows }, upcoming] = await Promise.all([
    attendanceRows({ semestr: sem, przedmiot }),
    end >= L.today() ? L.lessons(L.today(), end) : { lessons: [] },
  ]);
  const remaining = {};
  for (const l of upcoming.lessons) {
    if (!l.odwolana && !l.dzien_wolny && !L.isPast(l) && matches(przedmiot, l.przedmiot)) remaining[l.przedmiot] = (remaining[l.przedmiot] || 0) + 1;
  }
  const bySubject = new Map(groupBy(rows, "przedmiot"));
  const names = [...new Set([...bySubject.keys(), ...Object.keys(remaining)])].sort((a, b) => L.normalize(a).localeCompare(L.normalize(b)));
  return {
    semestr: sem,
    od: L.today(),
    koniec: end,
    prog_proc: prog,
    ogolem: forecast(rows, Object.values(remaining).reduce((a, b) => a + b, 0), prog),
    przedmioty: names.map((name) => ({ przedmiot: name, ...forecast(bySubject.get(name) || [], remaining[name] || 0, prog) })),
    uwaga: "Pozostałe lekcje z planu Librusa bez odwołanych i dni wolnych wpisanych do terminarza. " + attendanceNote(),
  };
}

export async function nieobecnosci({ od, do: to, przedmiot, semestr, typ } = {}) {
  const { rows } = await attendanceRows({ semestr: semestr ?? 0, od, do: to, przedmiot });
  const list = rows
    .filter((r) => r.skrot !== "ob")
    .filter((r) => !typ || L.normalize(r.skrot) === L.normalize(typ) || L.normalize(r.typ).includes(L.normalize(typ)));
  return { liczba: list.length, wpisy: list.map((r) => L.compact(r)), uwaga: attendanceNote() };
}

// --- plan i terminarz --------------------------------------------------------------------------

function dateRange(od, to, defaultStart, defaultDays, maxDays) {
  const start = L.checkDate(od, "od") || defaultStart;
  const end = L.checkDate(to, "do") || L.addDays(start, defaultDays);
  if (end < start) throw new Error("Data 'do' jest wcześniejsza niż 'od'.");
  if ((Date.parse(end) - Date.parse(start)) / 86400000 > maxDays) throw new Error(`Za długi zakres: najwyżej ${maxDays} dni naraz.`);
  return [start, end];
}

export async function planLekcji({ od, do: to } = {}) {
  let d = L.today();
  if (L.weekday(d) >= 5) d = L.addDays(d, 7 - L.weekday(d));
  const [start, end] = dateRange(od, to, L.mondayOf(d), od ? 6 : 4, 31);
  const { lessons, cal } = await L.lessons(start, end);
  const days = new Map();
  const day = (date) => {
    if (!days.has(date)) days.set(date, { data: date, dzien: L.DNI[L.weekday(date)], lekcje: [], wydarzenia: [] });
    return days.get(date);
  };
  for (const l of lessons) {
    day(l.data).lekcje.push(L.compact({
      nr: l.nr, godziny: l.godziny, przedmiot: l.przedmiot, nauczyciel: l.nauczyciel, grupa: l.grupa, sala: l.sala,
      odwolana: l.odwolana || null, zastepstwo: l.zamiast || /zast/i.test(l.uwaga || "") ? true : null,
      zamiast: l.zamiast, uwaga: l.uwaga,
    }));
  }
  for (const ev of cal.wydarzenia) {
    day(ev.data).wydarzenia.push(L.compact({ lekcja_nr: ev.lekcja_nr, godziny: ev.godziny, kategoria: ev.kategoria, przedmiot: ev.przedmiot, opis: ev.opis }));
  }
  for (const f of cal.dni_wolne) day(f.data).dzien_wolny = f.nazwa;
  return {
    od: start,
    do: end,
    dni: [...days.values()].sort((a, b) => a.data.localeCompare(b.data)).map((x) => L.compact({
      ...x, lekcje: x.lekcje.sort((a, b) => a.nr - b.nr),
    })),
  };
}

export async function terminarz({ od, do: to, przedmiot, kategoria } = {}) {
  const [start, end] = dateRange(od, to, L.today(), 14, 366);
  const cal = await L.months(start, end);
  const events = cal.wydarzenia
    .filter((e) => (!przedmiot || matches(przedmiot, e.przedmiot || "")) && matches(kategoria, e.kategoria))
    .map(({ id, ...e }) => L.compact({ ...e, dzien: L.DNI[L.weekday(e.data)] }))
    .sort((a, b) => a.data.localeCompare(b.data) || (a.lekcja_nr ?? 99) - (b.lekcja_nr ?? 99));
  return {
    od: start,
    do: end,
    liczba: events.length,
    wydarzenia: events,
    odwolane_lekcje: cal.odwolane.filter((o) => matches(przedmiot, o.przedmiot || "")),
    dni_wolne: cal.dni_wolne,
  };
}

// --- oceny -------------------------------------------------------------------------------------

/** Wartość do średniej jak w Librusie: '+' to +0.5, '-' to -0.25; np, nb, +, - się nie liczą. */
export function gradeValue(grade) {
  const g = String(grade ?? "").trim();
  if (!/^[0-9]/.test(g)) return null;
  return Number(g[0]) + (g[1] === "+" ? 0.5 : g[1] === "-" ? -0.25 : 0);
}

function parseGrade(g) {
  const info = String(g.info || "");
  const field = (name) => info.match(new RegExp(`(?:^|\\n)${name}:\\s*([^\\n]*)`))?.[1]?.trim();
  const weight = field("Waga");
  const counts = field("Licz do średniej");
  return L.compact({
    ocena: g.value,
    kategoria: field("Kategoria"),
    data: field("Data")?.slice(0, 10),
    waga: weight ? Number(weight) : null,
    do_sredniej: counts ? counts === "tak" && gradeValue(g.value) !== null : null,
    opis: field("Ocena"),
    komentarz: info.match(/\nKomentarz:\s*([\s\S]*)$/)?.[1]?.trim(),
    nauczyciel: field("Nauczyciel"),
  });
}

function weightedAverage(list) {
  const counted = list.filter((g) => g.do_sredniej !== false && gradeValue(g.ocena) !== null && (g.waga ?? 1) > 0);
  const weights = counted.reduce((s, g) => s + (g.waga ?? 1), 0);
  return weights ? Math.round((100 * counted.reduce((s, g) => s + gradeValue(g.ocena) * (g.waga ?? 1), 0)) / weights) / 100 : null;
}

export async function oceny({ przedmiot, semestr } = {}) {
  const subjects = await L.grades();
  const finite = (x) => (Number.isFinite(x) ? x : null);
  const result = [];
  for (const s of subjects) {
    if (!matches(przedmiot, s.name)) continue;
    const col = (i) => (s.semester?.[i]?.grades || []).map(parseGrade);
    const block = (i) => {
      const list = col(i);
      return list.length ? L.compact({ oceny: list, srednia_wazona: weightedAverage(list), srednia_librus: finite(s.semester?.[i]?.average) }) : null;
    };
    const entry = L.compact({
      przedmiot: s.name,
      semestr_1: semestr === 2 ? null : block(0),
      ocena_srodroczna: semestr === 2 ? null : col(1),
      semestr_2: semestr === 1 ? null : block(2),
      ocena_roczna: semestr === 1 ? null : col(3),
    });
    if (Object.keys(entry).length > 1 || przedmiot) result.push(entry);
  }
  return { uczen: await L.student(), przedmioty: result, uwaga: "Średnia ważona liczona jak w Librusie: '+' = +0,5, '-' = −0,25." };
}

// --- serwer MCP --------------------------------------------------------------------------------

const text = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const date = (what) => z.string().optional().describe(`${what} RRRR-MM-DD`);

export function createServer() {
  const server = new McpServer(
    { name: "librus", version: "2.0.0" },
    { instructions: "Frekwencja, oceny, plan lekcji i terminarz ucznia z Librus Synergia. Daty zawsze RRRR-MM-DD." },
  );

  server.registerTool("frekwencja", {
    title: "Frekwencja",
    description: "Frekwencja ucznia z Librusa ogółem i dla każdego przedmiotu, domyślnie w bieżącym semestrze: lekcje, " +
      "obecności, nieobecności, procent, rozbicie na typy wpisów, obecnosci_do_progu (na ilu kolejnych lekcjach trzeba być, " +
      "żeby dobić do progu; 0 gdy próg osiągnięty) i mozna_jeszcze_opuscic (ile kolejnych lekcji można opuścić).",
    inputSchema: {
      semestr: z.number().int().min(0).max(2).optional().describe("1 albo 2; domyślnie bieżący semestr; 0 = cały rok szkolny"),
      od: date("Pierwszy dzień"),
      do: date("Ostatni dzień"),
      przedmiot: z.string().optional().describe("Fragment nazwy przedmiotu, np. 'mat'"),
      prog: z.number().optional().describe("Próg frekwencji w procentach (domyślnie 50, próg nieklasyfikowania)"),
    },
  }, async (args) => text(await frekwencja(args)));

  server.registerTool("do_konca_semestru", {
    title: "Prognoza do końca semestru",
    description: "Czy zdążysz dobić do progu frekwencji do końca bieżącego semestru, według planu lekcji z Librusa: dla każdego " +
      "przedmiotu zostalo_lekcji, obecnosci_do_progu, zdazysz, mozna_opuscic_do_konca (ile z pozostałych lekcji można opuścić " +
      "i nadal skończyć na progu) i max_frekwencja_na_koniec_proc.",
    inputSchema: {
      prog: z.number().optional().describe("Próg w procentach (domyślnie 50)"),
      przedmiot: z.string().optional().describe("Fragment nazwy przedmiotu"),
      koniec: date("Ostatni dzień do policzenia (domyślnie koniec bieżącego semestru)"),
    },
  }, async (args) => text(await doKoncaSemestru(args)));

  server.registerTool("plan_lekcji", {
    title: "Plan lekcji",
    description: "Plan lekcji z Librusa dzień po dniu: numer lekcji, godziny, przedmiot, nauczyciel, grupa, sala, odwołane " +
      "lekcje, zastępstwa (z tym, co było zamiast), dni wolne oraz sprawdziany i inne wydarzenia z terminarza danego dnia. " +
      "Domyślnie bieżący tydzień szkolny (w weekend następny); najwyżej 31 dni. Odwołania i zastępstwa szkoła wpisuje zwykle dzień–dwa wcześniej.",
    inputSchema: {
      od: date("Pierwszy dzień (domyślnie poniedziałek bieżącego tygodnia, w weekend następnego)"),
      do: date("Ostatni dzień (domyślnie piątek; przy samym 'od' – tydzień od tego dnia)"),
    },
  }, async (args) => text(await planLekcji(args)));

  server.registerTool("terminarz", {
    title: "Terminarz",
    description: "Terminarz z Librusa: sprawdziany, kartkówki, wycieczki, próbne matury i inne wydarzenia (data, lekcja lub " +
      "godziny, kategoria, przedmiot, opis, nauczyciel), a także odwołane lekcje i dni wolne. Domyślnie 14 dni od dziś.",
    inputSchema: {
      od: date("Pierwszy dzień (domyślnie dziś)"),
      do: date("Ostatni dzień (domyślnie 14 dni od 'od', najwyżej 366 dni)"),
      przedmiot: z.string().optional().describe("Fragment nazwy przedmiotu"),
      kategoria: z.string().optional().describe("Fragment kategorii, np. 'sprawdzian', 'kartk'"),
    },
  }, async (args) => text(await terminarz(args)));

  server.registerTool("nieobecnosci", {
    title: "Nieobecności",
    description: "Konkretne nieobecności (usprawiedliwione i nie), spóźnienia i zwolnienia: data, dzień tygodnia, numer lekcji, " +
      "godziny, przedmiot, typ. Domyślnie cały rok szkolny.",
    inputSchema: {
      od: date("Pierwszy dzień"),
      do: date("Ostatni dzień"),
      przedmiot: z.string().optional().describe("Fragment nazwy przedmiotu"),
      semestr: z.number().int().min(0).max(2).optional().describe("1 albo 2; domyślnie cały rok"),
      typ: z.string().optional().describe("Skrót albo fragment typu: 'nb', 'u', 'sp', 'zw', 'nieobecność'"),
    },
  }, async (args) => text(await nieobecnosci(args)));

  server.registerTool("oceny", {
    title: "Oceny",
    description: "Oceny z Librusa według przedmiotów: cząstkowe z kategorią, wagą, datą i komentarzem, średnia ważona " +
      "(jak w Librusie: '+' = +0,5, '-' = -0,25) oraz oceny śródroczne i roczne.",
    inputSchema: {
      przedmiot: z.string().optional().describe("Fragment nazwy przedmiotu"),
      semestr: z.number().int().min(1).max(2).optional().describe("1 albo 2; domyślnie oba"),
    },
  }, async (args) => text(await oceny(args)));

  return server;
}
