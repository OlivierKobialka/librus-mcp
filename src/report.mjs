// node server.mjs --test: to samo, co widzi Claude, w czytelnej postaci w terminalu.
import * as L from "./librus.mjs";
import { doKoncaSemestru, frekwencja, oceny, planLekcji, terminarz } from "./tools.mjs";

const pad = (text, n) => String(text ?? "").slice(0, n).padEnd(n);

async function section(title, fn) {
  try {
    await fn();
  } catch (e) {
    console.log(`\n${title} niedostępne: ${e?.message || e}`);
  }
}

export async function runTest() {
  let att;
  try {
    att = await frekwencja();
  } catch (e) {
    console.log(`BŁĄD: ${e?.message || e}`);
    process.exitCode = 1;
    return;
  }
  const status = (s) => (s.ponizej_progu ? `do 50% musisz być jeszcze ${s.obecnosci_do_progu}×` : `ok, możesz opuścić ${s.mozna_jeszcze_opuscic}`);
  const total = att.ogolem;
  console.log(`Zalogowano: ${att.uczen.imie_nazwisko ?? "?"} ${att.uczen.klasa ?? ""}`.trim());
  console.log(`Semestr ${att.zakres.semestr} (${att.zakres.od} – ${att.zakres.do}), frekwencja ogółem: ${total.frekwencja_proc}% ` +
    `(${total.obecnosci}/${total.lekcje})${total.lekcje ? `, ${status(total)}` : ""}`);
  console.log(`Typy wpisów: ${Object.entries(total.wg_typu).map(([k, v]) => `${k} ${v}×`).join(", ")}\n`);
  for (const p of att.przedmioty) {
    console.log(`  ${pad(p.przedmiot, 38)} ${String(p.frekwencja_proc).padStart(6)}%  ${String(p.obecnosci).padStart(3)}/${pad(p.lekcje, 3)}  ${status(p)}`);
  }
  console.log(`\n${att.uwaga}`);

  await section("Prognoza do końca semestru", async () => {
    const plan = await doKoncaSemestru();
    console.log(`\nDo końca semestru (${plan.koniec}) wg planu zostało lekcji: ${plan.ogolem.zostalo_lekcji}`);
    for (const p of plan.przedmioty) {
      const verdict = p.zdazysz ? `zdążysz: możesz opuścić najwyżej ${p.mozna_opuscic_do_konca}`
        : `NIE zdążysz: nawet bez nieobecności skończysz na ${p.max_frekwencja_na_koniec_proc}%`;
      console.log(`  ${pad(p.przedmiot, 38)} zostało ${String(p.zostalo_lekcji).padStart(3)}   ${verdict}`);
    }
  });

  await section("Plan lekcji", async () => {
    const monday = L.addDays(L.mondayOf(L.today()), 7);
    const plan = await planLekcji({ od: monday, do: L.addDays(monday, 4) });
    console.log(`\nPlan na przyszły tydzień (${plan.od} – ${plan.do}):`);
    for (const d of plan.dni) {
      console.log(`  ${d.dzien} ${d.data}${d.dzien_wolny ? ` – DZIEŃ WOLNY: ${d.dzien_wolny}` : ""}`);
      for (const l of d.lekcje || []) {
        const flags = [l.odwolana && "ODWOŁANA", l.zastepstwo && `ZASTĘPSTWO${l.zamiast ? ` (zamiast: ${l.zamiast.przedmiot ?? "?"})` : ""}`,
          l.uwaga && `[${l.uwaga}]`].filter(Boolean).join(" ");
        console.log(`    ${l.nr}. ${pad(l.godziny, 12)} ${pad(l.przedmiot, 34)} ${l.nauczyciel ?? "?"} | sala ${l.sala ?? "?"} ${flags}`.trimEnd());
      }
      for (const e of d.wydarzenia || []) console.log(`    * ${e.kategoria}${e.przedmiot ? ` (${e.przedmiot})` : ""}: ${String(e.opis ?? "").slice(0, 60)}`);
    }
  });

  await section("Terminarz", async () => {
    const cal = await terminarz({ do: L.addDays(L.today(), 30) });
    console.log(`\nTerminarz na 30 dni, wydarzeń: ${cal.liczba}, odwołanych lekcji: ${cal.odwolane_lekcje.length}, dni wolnych: ${cal.dni_wolne.length}`);
    for (const e of cal.wydarzenia) {
      const head = [e.data, e.dzien.slice(0, 3), e.lekcja_nr != null ? `lekcja ${e.lekcja_nr}` : e.godziny, e.kategoria,
        e.przedmiot && `(${e.przedmiot})`].filter(Boolean).join(" ");
      console.log(`  ${head}: ${String(e.opis ?? "").replace(/\s+/g, " ").slice(0, 70)}`);
    }
    for (const f of cal.dni_wolne) console.log(`  ${f.data} dzień wolny: ${f.nazwa}`);
  });

  await section("Oceny", async () => {
    const g = await oceny();
    const count = g.przedmioty.reduce((n, p) => n + (p.semestr_1?.oceny.length ?? 0) + (p.semestr_2?.oceny.length ?? 0), 0);
    console.log(`\nOceny: ${count} cząstkowych z ${g.przedmioty.length} przedmiotów.`);
    for (const p of g.przedmioty) {
      const s = p.semestr_1 || p.semestr_2;
      console.log(`  ${pad(p.przedmiot, 38)} ${(s?.oceny || []).map((x) => x.ocena).join(" ")}  średnia: ${s?.srednia_wazona ?? "–"}`);
    }
  });
}
