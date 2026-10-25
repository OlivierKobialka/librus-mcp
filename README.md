# Librus MCP: frekwencja i oceny dla Claude

Serwer MCP, który pobiera Twoją frekwencję i oceny z Librus Synergia. To te same dane,
które pokazuje frekwencja.edu.pl, tylko że brane prosto z Librusa: login i hasło
nie trafiają do żadnej strony pośredniczącej.

## Narzędzia, które dostaje Claude

| Narzędzie | Co zwraca |
|---|---|
| `frekwencja` | Frekwencja w bieżącym semestrze, ogółem i dla każdego przedmiotu: lekcje, obecności, nieobecności, %, rozbicie na typy wpisów, `obecnosci_do_progu` (na ilu kolejnych lekcjach musisz być, żeby dobić do progu) i `mozna_jeszcze_opuscic` (ile lekcji z rzędu możesz opuścić, zanim spadniesz pod próg). Filtry: semestr (`0` = cały rok), od/do, przedmiot, próg (domyślnie 50%). |
| `do_konca_semestru` | Prognoza z planu lekcji: ile lekcji każdego przedmiotu zostało do końca semestru (bez odwołanych), czy zdążysz dobić do progu, ile z nich możesz jeszcze opuścić i jaką frekwencję maksymalnie możesz mieć na koniec. Filtry: próg, przedmiot, `koniec` (inna data końca, np. początek ferii). |
| `plan_lekcji` | Plan dzień po dniu (domyślnie bieżący tydzień, w weekend następny; najwyżej 31 dni): nr lekcji, godziny, przedmiot, nauczyciel, sala, odwołane lekcje, zastępstwa z tym, co było zamiast, oraz dni wolne. |
| `terminarz` | Sprawdziany, kartkówki i inne wydarzenia z terminarza Librusa (domyślnie 14 dni od dziś): data, lekcja, kategoria, przedmiot, opis, kto wpisał. Filtry: od/do, przedmiot, kategoria. |
| `nieobecnosci` | Konkretne nieobecności, spóźnienia i zwolnienia: data, dzień tygodnia, nr lekcji, przedmiot, typ. Filtry: od/do, przedmiot, semestr, typ (np. `nb`, `sp`). |
| `oceny` | Oceny cząstkowe z kategorią i wagą, średnia ważona (jak w Librusie: `+` = +0,5, `-` = −0,25) oraz oceny i propozycje semestralne/roczne. |

## Uruchomienie

1. **Login i hasło.** Otwórz plik `.env` w tym folderze i wpisz:
   ```
   LIBRUS_LOGIN=1234567u
   LIBRUS_HASLO=twoje_haslo
   ```
   To login do **Librus Synergia** (ten sam, którym logujesz się na frekwencja.edu.pl).
   Konta Librus Rodzina (logowanie e-mailem) nie są obsługiwane.

2. **Test w terminalu:**
   ```bash
   uv run --script C:\Users\olivi\OneDrive\Pulpit\librus-mcp\librus_mcp.py --test
   ```
   Pokaże frekwencję dla każdego przedmiotu. Porównaj ją z frekwencja.edu.pl.

3. **Podłączenie do Claude** (już zrobione na tym komputerze; serwer działa lokalnie, więc tylko tutaj).

   *Claude Code (terminal i zakładka Code w aplikacji):*
   ```bash
   claude mcp add librus --scope user -- C:\Users\olivi\.local\bin\uv.exe run --quiet --script C:\Users\olivi\OneDrive\Pulpit\librus-mcp\librus_mcp.py
   ```

   *Claude Desktop (czat):* Ustawienia → Developer → Edit Config, a w pliku `claude_desktop_config.json`:
   ```json
   {
     "mcpServers": {
       "librus": {
         "command": "C:\\Users\\olivi\\.local\\bin\\uv.exe",
         "args": ["run", "--quiet", "--script", "C:\\Users\\olivi\\OneDrive\\Pulpit\\librus-mcp\\librus_mcp.py"]
       }
     }
   }
   ```
   Potem zrestartuj Claude Desktop.

## Zdalny konektor (Vercel, claude.ai na każdym urządzeniu)

Ten sam serwer działa też jako funkcja na Vercelu (`api/connector.py`, konfiguracja w `vercel.json`).
Dostęp jest tylko przez tajny token w adresie; każdy inny adres zwraca 404.

1. Wygeneruj token (zapisz go, będzie częścią adresu):
   ```bash
   python -c "import secrets; print(secrets.token_urlsafe(32))"
   ```
2. W Vercelu: projekt **librus-mcp** → Settings → Environment Variables, środowisko Production,
   najlepiej jako *Sensitive*: `LIBRUS_LOGIN`, `LIBRUS_HASLO`, `MCP_TOKEN` (ten token).
3. Wdrożenie idzie z gałęzi `master` na GitHubie. Po zmianie zmiennych zrób Redeploy.
4. Sprawdzenie: https://librus-mcp.vercel.app/health pokazuje tylko, czy zmienne są ustawione.
5. W claude.ai: Ustawienia → Konektory → Dodaj własny konektor, adres
   `https://librus-mcp.vercel.app/mcp/<TOKEN>`.

Kto zna ten adres, widzi Twoje oceny i frekwencję, więc nie udostępniaj go. Jeśli wycieknie,
zmień `MCP_TOKEN` w Vercelu, zrób Redeploy i podmień adres konektora.

Przykładowe pytania do Claude: *„Jaką mam frekwencję z matmy?”*, *„Ile lekcji fizyki mogę jeszcze opuścić?”*,
*„W które dni tygodnia najczęściej mnie nie ma?”*, *„Jaka jest moja średnia z polskiego?”*

## Dobrze wiedzieć

- Dane są trzymane w pamięci przez 10 minut, więc kilka pytań z rzędu nie loguje się do Librusa od nowa.
- Jako obecność liczą się wpisy, które Librus oznacza jako obecność (obecność, spóźnienie i podobne).
- Po kilku nieudanych logowaniach Librus wymaga CAPTCHA. Serwer wtedy przestaje próbować i prosi,
  żeby zalogować się raz ręcznie na synergia.librus.pl.
- Plik `.env` zawiera hasło. Nie wrzucaj go do gita ani nikomu nie wysyłaj. Pulpit jest synchronizowany
  z OneDrive, więc kopia `.env` trafia też na Twoje konto OneDrive.
