# Librus MCP: frekwencja i oceny dla Claude

Serwer MCP, który pobiera Twoją frekwencję i oceny z Librus Synergia. To te same dane,
które pokazuje frekwencja.edu.pl, tylko że brane prosto z Librusa: login i hasło
nie trafiają do żadnej strony pośredniczącej.

## Narzędzia, które dostaje Claude

| Narzędzie | Co zwraca |
|---|---|
| `frekwencja` | Frekwencja w bieżącym semestrze, ogółem i dla każdego przedmiotu: lekcje, obecności, nieobecności, %, rozbicie na typy wpisów, `obecnosci_do_progu` (na ilu kolejnych lekcjach musisz być, żeby dobić do progu) i `mozna_jeszcze_opuscic` (ile lekcji z rzędu możesz opuścić, zanim spadniesz pod próg). Filtry: semestr (`0` = cały rok), od/do, przedmiot, próg (domyślnie 50%). |
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

3. **Podłączenie do Claude.**

   *Claude Code (terminal i zakładka Code w aplikacji):*
   ```bash
   claude mcp add librus --scope user -- C:\Users\olivi\.local\bin\uv.exe run --quiet --script "C:\Users\olivi\OneDrive\Pulpit\librus-mcp\librus_mcp.py"
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

Przykładowe pytania do Claude: *„Jaką mam frekwencję z matmy?”*, *„Ile lekcji fizyki mogę jeszcze opuścić?”*,
*„W które dni tygodnia najczęściej mnie nie ma?”*, *„Jaka jest moja średnia z polskiego?”*

## Dobrze wiedzieć

- Dane są trzymane w pamięci przez 10 minut, więc kilka pytań z rzędu nie loguje się do Librusa od nowa.
- Jako obecność liczą się wpisy, które Librus oznacza jako obecność (obecność, spóźnienie i podobne).
- Po kilku nieudanych logowaniach Librus wymaga CAPTCHA. Serwer wtedy przestaje próbować i prosi,
  żeby zalogować się raz ręcznie na synergia.librus.pl.
- Plik `.env` zawiera hasło. Nie wrzucaj go do gita ani nikomu nie wysyłaj. Pulpit jest synchronizowany
  z OneDrive, więc kopia `.env` trafia też na Twoje konto OneDrive.
