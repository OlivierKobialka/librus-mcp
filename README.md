# Librus MCP: frekwencja, plan lekcji, terminarz i oceny w Claude

Serwer MCP, dzięki któremu Claude zna Twoją frekwencję, plan lekcji z zastępstwami, sprawdziany i oceny
z Librus Synergia. Logowanie i dane obsługuje biblioteka [librus-api](https://github.com/Mati365/librus-api).

Każdy stawia **własną kopię**: Twój login i hasło są tylko w Twoim Vercelu albo na Twoim komputerze.

## Co potrafi

| Narzędzie | Co zwraca |
|---|---|
| `frekwencja` | Frekwencja w bieżącym semestrze, ogółem i dla każdego przedmiotu: lekcje, obecności, nieobecności, %, typy wpisów, `obecnosci_do_progu` (na ilu kolejnych lekcjach musisz być, żeby dobić do 50%) i `mozna_jeszcze_opuscic`. |
| `do_konca_semestru` | Ile lekcji każdego przedmiotu zostało do końca semestru, czy zdążysz dobić do progu i ile z nich możesz jeszcze opuścić. |
| `plan_lekcji` | Plan dzień po dniu: godziny, przedmiot, nauczyciel, grupa, sala, odwołane lekcje, zastępstwa, dni wolne i sprawdziany danego dnia. |
| `terminarz` | Sprawdziany, kartkówki, wycieczki i inne wydarzenia, a także odwołane lekcje i dni wolne. |
| `nieobecnosci` | Konkretne nieobecności, spóźnienia i zwolnienia z datą, lekcją i przedmiotem. |
| `oceny` | Oceny z kategorią, wagą i komentarzem, średnia ważona, oceny śródroczne i roczne. |

Przykładowe pytania: *„Ile lekcji fizyki mogę jeszcze opuścić?”*, *„Co mam jutro i czy jest jakiś sprawdzian?”*,
*„Czy zdążę dobić 50% z niemieckiego do końca semestru?”*, *„Jaka jest moja średnia z polskiego?”*

## Szybki start: własny konektor na Vercelu (claude.ai, też na telefonie)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FOlivierKobialka%2Flibrus-mcp&project-name=librus-mcp&repository-name=librus-mcp&env=LIBRUS_LOGIN,LIBRUS_HASLO,MCP_TOKEN&envDescription=Login%20i%20has%C5%82o%20do%20Librus%20Synergia%20oraz%20tajny%20token%20(min.%2032%20znaki%2C%20litery%2C%20cyfry%2C%20-%20i%20_)&envLink=https%3A%2F%2Fgithub.com%2FOlivierKobialka%2Flibrus-mcp%23readme)

1. **Wygeneruj tajny token** (co najmniej 32 znaki). Zapisz go, będzie częścią adresu konektora.
   - Windows (PowerShell):
     ```powershell
     $b = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | % { $_.ToString('x2') })
     ```
   - macOS / Linux:
     ```bash
     openssl rand -hex 24
     ```
2. **Kliknij „Deploy with Vercel”** powyżej i zaloguj się kontem GitHub (darmowe konto Vercel wystarczy).
   Vercel zrobi Twoją kopię repozytorium i zapyta o trzy zmienne:
   - `LIBRUS_LOGIN`: login do **Librus Synergia** (np. `1234567u`; logowanie e-mailem z Librus Rodzina nie działa),
   - `LIBRUS_HASLO`: hasło do Librusa,
   - `MCP_TOKEN`: token z punktu 1.
3. **Sprawdź wdrożenie:** otwórz `https://<twój-projekt>.vercel.app/health`. Wszystkie pola mają być `true`.
4. **Dodaj konektor w claude.ai:** Ustawienia → Konektory → Dodaj własny konektor, adres:
   ```
   https://<twój-projekt>.vercel.app/mcp/<MCP_TOKEN>
   ```
5. W nowym czacie włącz konektor i zapytaj: *„Jaką mam frekwencję?”*

**Bezpieczeństwo**
- Adres z tokenem daje dostęp do Twoich ocen i frekwencji. Nie wysyłaj go nikomu, także znajomym: każdy robi swoją kopię.
- Nie podawaj swojego hasła do Librusa ani adresu konektora nikomu, kto obiecuje „postawić Ci serwer”.
- W Vercelu oznacz zmienne jako *Sensitive*. Jeśli adres wycieknie: zmień `MCP_TOKEN`, zrób Redeploy i podmień adres w claude.ai.
- Każdy inny adres niż `/mcp/<token>` i `/health` zwraca 404, a `/health` pokazuje tylko, czy zmienne są ustawione.

## Lokalnie (Claude Code, Claude Desktop)

Potrzebny [Node.js](https://nodejs.org) 20 lub nowszy.

```bash
git clone https://github.com/OlivierKobialka/librus-mcp.git
cd librus-mcp
npm install
```

W folderze projektu utwórz plik `.env`:
```
LIBRUS_LOGIN=1234567u
LIBRUS_HASLO=twoje_haslo
```

Test w terminalu (frekwencja, prognoza, plan na przyszły tydzień, terminarz, oceny):
```bash
node server.mjs --test
```

Podłączenie (`<ŚCIEŻKA>` to pełna ścieżka do folderu projektu):
- **Claude Code:**
  ```bash
  claude mcp add librus --scope user -- node <ŚCIEŻKA>/server.mjs
  ```
- **Claude Desktop:** Ustawienia → Developer → Edit Config:
  ```json
  { "mcpServers": { "librus": { "command": "node", "args": ["<ŚCIEŻKA>/server.mjs"] } } }
  ```
  Potem zamknij Claude całkowicie (także z zasobnika) i uruchom ponownie.

## Daty semestru

Koniec 1. semestru i roku szkolnego serwer bierze z Librusa (dane Twojej klasy), więc zwykle nic nie trzeba ustawiać.
Jeśli Librus ich nie poda, użyje `config.json` (`koniec_1_semestru`, `koniec_roku`; `null` = ostatni piątek stycznia / czerwca).
Zmienne `KONIEC_1_SEMESTRU` i `KONIEC_ROKU` (RRRR-MM-DD) mają pierwszeństwo przed wszystkim.

## Skąd są dane

- **Plan lekcji, terminarz, oceny, nieobecności, dane ucznia:** biblioteka librus-api (strony Synergii).
- **Frekwencja w procentach:** wpisy frekwencji z API JSON Librusa, pobierane przez sesję zalogowaną biblioteką.
  To te same wpisy, które widzi wychowawca i frekwencja.edu.pl, razem z obecnościami i zajęciami pozalekcyjnymi.
  Wpisy, które Librus oznacza jako obecność (np. spóźnienie, zwolnienie), liczą się jako obecność.
- Gdyby API było niedostępne, serwer liczy frekwencję zapasowo z planu lekcji (bez odwołanych lekcji i dni wolnych)
  i pisze to w wyniku: taka liczba lekcji bywa zawyżona.

## Dla programistów

- `npm test`: testy bez sieci (udawany klient librus-api); uruchamiaj w kopii bez `.env`.
- `node scripts/probe.mjs`: zapisuje do `debug/` surowe wyniki metod librus-api z Twojego konta (folder jest w `.gitignore`, zawiera Twoje dane, usuń go po użyciu).
- Kod: `src/librus.mjs` (logowanie, cache, dane z biblioteki i z API przez jej sesję), `src/tools.mjs` (narzędzia MCP), `server.mjs` (stdio), `api/connector.js` (Vercel).
