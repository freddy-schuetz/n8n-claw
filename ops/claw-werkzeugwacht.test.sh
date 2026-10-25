#!/usr/bin/env bash
# Tests fuer ops/claw-werkzeugwacht.sh, ohne echten Server: "docker" und "curl"
# sind erfundene Befehle, die aus Steuerdateien antworten und ihre Aufrufe
# mitschreiben.
#
# Aufruf: bash ops/claw-werkzeugwacht.test.sh
set -uo pipefail

HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKRIPT="$HIER/claw-werkzeugwacht.sh"
GESAMT=0
FEHLER=0

pruefe() { # $1 Name, $2 Bedingung (0 = bestanden), $3 Zusatzinfo
  GESAMT=$((GESAMT + 1))
  if [ "$2" -eq 0 ]; then
    printf 'PASS %s\n' "$1"
  else
    FEHLER=$((FEHLER + 1))
    printf 'FAIL %s\n     -> %s\n' "$1" "${3:-}"
  fi
}
ja_wenn() { if grep -qE "$2" "$1" 2>/dev/null; then echo 0; else echo 1; fi; }
nein_wenn() { if grep -qE "$2" "$1" 2>/dev/null; then echo 1; else echo 0; fi; }
zeilen_mit() { grep -cE "$2" "$1" 2>/dev/null || true; }

# $1 = Tabellenzeilen "server<TAB>fehler<TAB>ok<TAB>text", $2 = Telegram-Code
aufbau() {
  BUEHNE=$(mktemp -d)
  mkdir -p "$BUEHNE/bin" "$BUEHNE/projekt/ops" "$BUEHNE/zustand"
  printf '%b' "$1" > "$BUEHNE/tabelle"
  printf '%s' "${2:-200}" > "$BUEHNE/tg_code"
  printf '0' > "$BUEHNE/db_rc"
  printf '0' > "$BUEHNE/leer"
  printf '0\t0\t-\t-\n' > "$BUEHNE/abbruch"
  printf '0' > "$BUEHNE/abbruch_rc"
  : > "$BUEHNE/telegram"
  : > "$BUEHNE/aufrufe"
  {
    printf 'TELEGRAM_BOT_TOKEN=%s\n' 'geheim:ABC-123-token'
    printf 'TELEGRAM_CHAT_ID=1810565648\n'
  } > "$BUEHNE/projekt/.env"
  cat > "$BUEHNE/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >> "$BUEHNE/aufrufe"
rc=$(cat "$BUEHNE/db_rc")
if [ "$rc" != "0" ]; then printf 'Error response from daemon: container not running\n' >&2; exit "$rc"; fi
case "$*" in
  *"ohne Eingabe"*) cat "$BUEHNE/leer" ;;
  *"agent_abbruch"*)
    if [ "$(cat "$BUEHNE/abbruch_rc")" != "0" ]; then printf 'ERROR:  column "scope" does not exist\n' >&2; exit 1; fi
    cat "$BUEHNE/abbruch" ;;
  *) cat "$BUEHNE/tabelle" ;;
esac
DOCKER
  cat > "$BUEHNE/bin/curl" <<'CURL'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$BUEHNE/aufrufe"
text=""
while [ $# -gt 0 ]; do
  case "$1" in
    --data-urlencode) shift; case "$1" in text=*) text="${1#text=}" ;; esac ;;
  esac
  shift
done
printf '%s\n' "$text" >> "$BUEHNE/telegram"
cat "$BUEHNE/tg_code"
CURL
  chmod +x "$BUEHNE/bin/docker" "$BUEHNE/bin/curl"
}

lauf() {
  PATH="$BUEHNE/bin:$PATH" BUEHNE="$BUEHNE" \
  CLAW_PROJEKT="$BUEHNE/projekt" CLAW_WERKZEUG_ZUSTAND="$BUEHNE/zustand" \
  CLAW_WERKZEUG_LOG="$BUEHNE/log" \
    bash "$SKRIPT" > "$BUEHNE/ausgabe" 2>&1
  printf '%s' "$?" > "$BUEHNE/rc"
}
rc_ist() { if [ "$(cat "$BUEHNE/rc")" = "$1" ]; then echo 0; else echo 1; fi; }
T=$'\t'

# 1. Keine Zeilen: nichts melden
aufbau ""
lauf
pruefe "ohne Aufrufe keine Meldung" "$( [ -s "$BUEHNE/telegram" ] && echo 1 || echo 0 )" "$(cat "$BUEHNE/telegram")"
pruefe "ohne Aufrufe Rueckgabe 0" "$(rc_ist 0)" "$(cat "$BUEHNE/rc")"

# 2. Kalender 5 Fehler, 0 Erfolge: genau eine Meldung mit Server und Fehlertext
aufbau "microsoft-calendar${T}5${T}0${T}tool returned error: There was an error: \"Invalid parameter key\"\nconfluence${T}0${T}12${T}\n"
lauf
pruefe "Ausfall wird gemeldet" "$(ja_wenn "$BUEHNE/telegram" 'microsoft-calendar hat seit dem letzten Erfolg 5 Fehler')" "$(cat "$BUEHNE/telegram")"
pruefe "Meldung traegt den Fehlertext" "$(ja_wenn "$BUEHNE/telegram" 'Invalid parameter key')" "$(cat "$BUEHNE/telegram")"
pruefe "gesunder Server wird nicht gemeldet" "$(nein_wenn "$BUEHNE/telegram" 'confluence')" "$(cat "$BUEHNE/telegram")"
pruefe "Zustand fuer den Server angelegt" "$( [ -f "$BUEHNE/zustand/server-microsoft-calendar" ] && echo 0 || echo 1 )" "$(ls "$BUEHNE/zustand")"
pruefe "Token nicht in der Prozessliste (nur per --config)" "$(nein_wenn "$BUEHNE/aufrufe" 'ABC-123-token')" "$(cat "$BUEHNE/aufrufe")"
pruefe "Token-Datei aufgeraeumt" "$( ls "$BUEHNE/zustand"/.telegram.* >/dev/null 2>&1 && echo 1 || echo 0 )" "$(ls -a "$BUEHNE/zustand")"

# 3. Zweiter Lauf direkt danach: gedrosselt, keine zweite Meldung
lauf
pruefe "zweiter Lauf meldet nicht erneut" "$( [ "$(zeilen_mit "$BUEHNE/telegram" 'microsoft-calendar')" = "1" ] && echo 0 || echo 1 )" "$(cat "$BUEHNE/telegram")"

# 4. Nach Ablauf des Abstands wird wieder gemeldet
printf '%s' "$(( $(date +%s) - 22000 ))" > "$BUEHNE/zustand/server-microsoft-calendar"
lauf
pruefe "nach sechs Stunden erneute Meldung" "$( [ "$(zeilen_mit "$BUEHNE/telegram" 'microsoft-calendar hat seit')" = "2" ] && echo 0 || echo 1 )" "$(cat "$BUEHNE/telegram")"

# 5. Erholung: letzter Aufruf erfolgreich beim gemeldeten Server -> einmal Entwarnung, Zustand weg
printf '%b' "microsoft-calendar${T}0${T}4${T}\n" > "$BUEHNE/tabelle"
lauf
pruefe "Entwarnung bei Erholung" "$(ja_wenn "$BUEHNE/telegram" 'microsoft-calendar antwortet wieder')" "$(cat "$BUEHNE/telegram")"
pruefe "Zustand nach Entwarnung entfernt" "$( [ -f "$BUEHNE/zustand/server-microsoft-calendar" ] && echo 1 || echo 0 )" "$(ls "$BUEHNE/zustand")"
lauf
pruefe "Entwarnung nur einmal" "$( [ "$(zeilen_mit "$BUEHNE/telegram" 'antwortet wieder')" = "1" ] && echo 0 || echo 1 )" "$(cat "$BUEHNE/telegram")"

# 6. Selten genutzter Server: zwei Fehler ohne Erfolg in 24 Stunden melden, einer nicht
aufbau "jira${T}2${T}0${T}Fehler\n"
lauf
pruefe "selten genutzt: zwei Fehler ohne Erfolg werden gemeldet" "$(ja_wenn "$BUEHNE/telegram" 'jira hatte in 24 Stunden 2 Fehler und keinen Erfolg')" "$(cat "$BUEHNE/telegram")"
aufbau "jira${T}1${T}0${T}Fehler\n"
lauf
pruefe "ein einzelner Fehler wird nicht gemeldet" "$( [ -s "$BUEHNE/telegram" ] && echo 1 || echo 0 )" "$(cat "$BUEHNE/telegram")"

# 7. Fehler nach frueherem Erfolg: ab drei seit dem letzten Erfolg melden, zwei nicht
aufbau "jira${T}6${T}1${T}Fehler\n"
lauf
pruefe "sechs Fehler seit dem letzten Erfolg werden gemeldet" "$(ja_wenn "$BUEHNE/telegram" 'jira hat seit dem letzten Erfolg 6 Fehler')" "$(cat "$BUEHNE/telegram")"
aufbau "jira${T}2${T}5${T}Fehler\n"
lauf
pruefe "zwei Fehler nach Erfolgen sind kein Ausfall" "$( [ -s "$BUEHNE/telegram" ] && echo 1 || echo 0 )" "$(cat "$BUEHNE/telegram")"

# 8. Pause: gar nichts, nicht einmal die Abfrage
aufbau "jira${T}9${T}0${T}Fehler\n"
: > "$BUEHNE/projekt/ops/PAUSE"
lauf
pruefe "Pause: keine Meldung" "$( [ -s "$BUEHNE/telegram" ] && echo 1 || echo 0 )" "$(cat "$BUEHNE/telegram")"
pruefe "Pause: keine Datenbankabfrage" "$(nein_wenn "$BUEHNE/aufrufe" '^docker')" "$(cat "$BUEHNE/aufrufe")"

# 9. Datenbank nicht erreichbar: keine Meldung, Rueckgabe 0, Logzeile
aufbau "jira${T}9${T}0${T}Fehler\n"
printf '1' > "$BUEHNE/db_rc"
lauf
pruefe "DB weg: keine Meldung" "$( [ -s "$BUEHNE/telegram" ] && echo 1 || echo 0 )" "$(cat "$BUEHNE/telegram")"
pruefe "DB weg: Rueckgabe 0" "$(rc_ist 0)" "$(cat "$BUEHNE/rc")"
pruefe "DB weg: Logzeile" "$(ja_wenn "$BUEHNE/log" 'Datenbank nicht abfragbar')" "$(cat "$BUEHNE/log" 2>/dev/null)"

# 10. Telegram scheitert: kein Zustand, naechster Lauf versucht es wieder
aufbau "jira${T}9${T}0${T}Fehler\n" 500
lauf
pruefe "Telegram 500: kein Zustand vermerkt" "$( [ -f "$BUEHNE/zustand/server-jira" ] && echo 1 || echo 0 )" "$(ls "$BUEHNE/zustand")"
printf '200' > "$BUEHNE/tg_code"
lauf
pruefe "naechster Lauf stellt zu" "$( [ -f "$BUEHNE/zustand/server-jira" ] && echo 0 || echo 1 )" "$(cat "$BUEHNE/log")"

# 11. Kaputte Zeilen (keine Zahlen) werden uebergangen
aufbau "kaputt${T}x${T}y${T}z\nmicrosoft-mail${T}3${T}0${T}Fehler\n"
lauf
pruefe "kaputte Zeile uebergangen, gueltige gemeldet" "$( [ "$(zeilen_mit "$BUEHNE/telegram" 'Werkzeugwache')" = "1" ] && echo 0 || echo 1 )" "$(cat "$BUEHNE/telegram")"

# 13. Leere Werkzeugaufrufe: ab drei melden, gedrosselt, zwei nicht
aufbau ""
printf '5' > "$BUEHNE/leer"
lauf
pruefe "fuenf leere Aufrufe werden gemeldet" "$(ja_wenn "$BUEHNE/telegram" '5 Werkzeugaufrufe ohne Eingabe')" "$(cat "$BUEHNE/telegram")"
lauf
pruefe "leere Aufrufe nur einmal je sechs Stunden" "$( [ "$(zeilen_mit "$BUEHNE/telegram" 'ohne Eingabe')" = "1" ] && echo 0 || echo 1 )" "$(cat "$BUEHNE/telegram")"
aufbau ""
printf '2' > "$BUEHNE/leer"
lauf
pruefe "zwei leere Aufrufe werden nicht gemeldet" "$( [ -s "$BUEHNE/telegram" ] && echo 1 || echo 0 )" "$(cat "$BUEHNE/telegram")"

# 12. Ungueltige Konfiguration bricht ab, bevor irgendetwas abgefragt wird
aufbau "jira${T}9${T}0${T}Fehler\n"
PATH="$BUEHNE/bin:$PATH" BUEHNE="$BUEHNE" CLAW_PROJEKT="$BUEHNE/projekt" CLAW_WERKZEUG_ZUSTAND="$BUEHNE/zustand" \
  CLAW_WERKZEUG_LOG="$BUEHNE/log" CLAW_WERKZEUG_FENSTER_MIN="60; drop table x" bash "$SKRIPT" > "$BUEHNE/ausgabe" 2>&1
printf '%s' "$?" > "$BUEHNE/rc"
pruefe "ungueltige Zahl: Abbruch mit 1" "$(rc_ist 1)" "$(cat "$BUEHNE/rc")"
pruefe "ungueltige Zahl: keine Abfrage" "$(nein_wenn "$BUEHNE/aufrufe" '^docker')" "$(cat "$BUEHNE/aufrufe")"

# 14. Abbruchregel (Runde 11 Teilrunde 2): Vermerke mit alarm agent_abbruch
abbruch_setzen() { printf '%b' "$1" > "$BUEHNE/abbruch"; }
aufbau ""
abbruch_setzen "2${T}2${T}guthaben${T}Bad request - please check your parameters\n"
lauf
pruefe "Abbruch: Meldung mit Zahl, Art und Grund" "$(ja_wenn "$BUEHNE/telegram" 'Agent-Abbrueche durch Modellfehler, 2 in den letzten 15 Minuten, 2 in den letzten 60 Minuten. Art \(vermutet\): guthaben. Letzter Grund: Bad request - please check your parameters')" "$(cat "$BUEHNE/telegram")"
pruefe "Abbruch: Hinweis auf das Anthropic-Konto" "$(ja_wenn "$BUEHNE/telegram" 'Anthropic-Konto')" "$(cat "$BUEHNE/telegram")"
pruefe "Abbruch: Zustand angelegt" "$( [ -f "$BUEHNE/zustand/agent-abbruch" ] && echo 0 || echo 1 )" "$(ls "$BUEHNE/zustand")"
pruefe "Abbruch: Abfrage liest nur betrieb, error und den Marker" "$(ja_wenn "$BUEHNE/aufrufe" "scope = 'betrieb' and category = 'error' and metadata->>'alarm' = 'agent_abbruch'")" "$(grep -c agent_abbruch "$BUEHNE/aufrufe")"
pruefe "Abbruch: Fenster 15 Minuten, Ruhe 60 Minuten" "$( grep -q "interval '15 minutes'" "$BUEHNE/aufrufe" && grep -q "interval '60 minutes'" "$BUEHNE/aufrufe" && echo 0 || echo 1 )" "$(grep -o "interval '[0-9]* minutes'" "$BUEHNE/aufrufe" | sort -u | tr '\n' ' ')"
pruefe "Abbruch: Abfrage liest keinen Vermerktext" "$(nein_wenn "$BUEHNE/aufrufe" 'content|owner_user_id')" "$(grep agent_abbruch "$BUEHNE/aufrufe" | head -c 300)"
pruefe "Abbruch: Art nur Kleinbuchstaben, Grund ohne Tab und Zeilenumbruch" "$( grep -qF "'[^a-z_]', '', 'g'" "$BUEHNE/aufrufe" && grep -qF "'[[:space:]]+', ' ', 'g'), 150)" "$BUEHNE/aufrufe" && echo 0 || echo 1 )" "$(grep -o "regexp_replace[^)]*" "$BUEHNE/aufrufe" | head -3)"
pruefe "Abbruch: Meldung ohne Person und Sitzung" "$(nein_wenn "$BUEHNE/telegram" 'entra:|teams:|web:|Sitzung')" "$(cat "$BUEHNE/telegram")"
lauf
pruefe "Abbruch: binnen einer Stunde nicht erneut" "$( [ "$(zeilen_mit "$BUEHNE/telegram" 'Agent-Abbrueche')" = "1" ] && echo 0 || echo 1 )" "$(cat "$BUEHNE/telegram")"
printf '%s' "$(( $(date +%s) - 3700 ))" > "$BUEHNE/zustand/agent-abbruch"
lauf
pruefe "Abbruch: nach einer Stunde erneut, solange Abbrueche kommen" "$( [ "$(zeilen_mit "$BUEHNE/telegram" 'Agent-Abbrueche')" = "2" ] && echo 0 || echo 1 )" "$(cat "$BUEHNE/telegram")"
abbruch_setzen "0${T}3${T}guthaben${T}Bad request\n"
lauf
pruefe "Abbruch: keine Entwarnung, solange in der Stunde Abbrueche stehen" "$(nein_wenn "$BUEHNE/telegram" 'Entwarnung')" "$(cat "$BUEHNE/telegram")"
pruefe "Abbruch: Zustand bleibt bis zur Entwarnung" "$( [ -f "$BUEHNE/zustand/agent-abbruch" ] && echo 0 || echo 1 )" "$(ls "$BUEHNE/zustand")"
abbruch_setzen "0${T}0${T}-${T}-\n"
lauf
pruefe "Abbruch: Entwarnung nach einer Stunde Ruhe" "$(ja_wenn "$BUEHNE/telegram" 'seit 60 Minuten kein Agent-Abbruch durch Modellfehler mehr. Entwarnung')" "$(cat "$BUEHNE/telegram")"
pruefe "Abbruch: Zustand nach der Entwarnung entfernt" "$( [ -f "$BUEHNE/zustand/agent-abbruch" ] && echo 1 || echo 0 )" "$(ls "$BUEHNE/zustand")"
lauf
pruefe "Abbruch: Entwarnung nur einmal" "$( [ "$(zeilen_mit "$BUEHNE/telegram" 'Entwarnung')" = "1" ] && echo 0 || echo 1 )" "$(cat "$BUEHNE/telegram")"
aufbau ""
lauf
pruefe "Abbruch: ohne Meldung vorher keine Entwarnung" "$( [ -s "$BUEHNE/telegram" ] && echo 1 || echo 0 )" "$(cat "$BUEHNE/telegram")"
aufbau "" 500
abbruch_setzen "1${T}1${T}ueberlast${T}The service failed to process your request\n"
lauf
pruefe "Abbruch: Telegram 500, kein Zustand" "$( [ -f "$BUEHNE/zustand/agent-abbruch" ] && echo 1 || echo 0 )" "$(ls "$BUEHNE/zustand")"
printf '200' > "$BUEHNE/tg_code"
lauf
pruefe "Abbruch: naechster Lauf stellt zu" "$( [ -f "$BUEHNE/zustand/agent-abbruch" ] && echo 0 || echo 1 )" "$(cat "$BUEHNE/log")"
aufbau ""
abbruch_setzen "1${T}1${T}-${T}-\n"
lauf
pruefe "Abbruch: leere Hinweisfelder verschieben keine Spalten" "$(ja_wenn "$BUEHNE/telegram" 'Art \(vermutet\): -\. Letzter Grund: -\.')" "$(cat "$BUEHNE/telegram")"
aufbau ""
printf '1' > "$BUEHNE/abbruch_rc"
lauf
pruefe "Abbruch: Abfrage scheitert, keine Meldung" "$( [ -s "$BUEHNE/telegram" ] && echo 1 || echo 0 )" "$(cat "$BUEHNE/telegram")"
pruefe "Abbruch: Abfrage scheitert, Logzeile, Rueckgabe 0" "$( grep -q 'Abfrage Agent-Abbrueche gescheitert' "$BUEHNE/log" && [ "$(cat "$BUEHNE/rc")" = "0" ] && echo 0 || echo 1 )" "$(cat "$BUEHNE/log")"
aufbau ""
abbruch_setzen "x${T}y${T}z${T}w\n"
lauf
pruefe "Abbruch: unlesbare Zeile wird uebergangen" "$( [ ! -s "$BUEHNE/telegram" ] && grep -q 'Agent-Abbrueche unlesbar' "$BUEHNE/log" && echo 0 || echo 1 )" "$(cat "$BUEHNE/log")"
aufbau "microsoft-calendar${T}5${T}0${T}Invalid parameter key\n"
abbruch_setzen "1${T}1${T}schluessel${T}Authorization failed - please check your credentials\n"
lauf
pruefe "Abbruch und Serverregel melden getrennt" "$( [ "$(zeilen_mit "$BUEHNE/telegram" 'Werkzeugwache')" = "2" ] && echo 0 || echo 1 )" "$(cat "$BUEHNE/telegram")"
aufbau ""
abbruch_setzen "1${T}1${T}guthaben${T}Bad request\n"
PATH="$BUEHNE/bin:$PATH" BUEHNE="$BUEHNE" CLAW_PROJEKT="$BUEHNE/projekt" CLAW_WERKZEUG_ZUSTAND="$BUEHNE/zustand" \
  CLAW_WERKZEUG_LOG="$BUEHNE/log" CLAW_ABBRUCH_FENSTER_MIN="15; drop table x" bash "$SKRIPT" > "$BUEHNE/ausgabe" 2>&1
printf '%s' "$?" > "$BUEHNE/rc"
pruefe "Abbruch: ungueltiges Fenster bricht vor jeder Abfrage ab" "$( [ "$(cat "$BUEHNE/rc")" = "1" ] && ! grep -q '^docker' "$BUEHNE/aufrufe" && echo 0 || echo 1 )" "$(cat "$BUEHNE/aufrufe")"
aufbau ""
abbruch_setzen "1${T}1${T}guthaben${T}Bad request\n"
PATH="$BUEHNE/bin:$PATH" BUEHNE="$BUEHNE" CLAW_PROJEKT="$BUEHNE/projekt" CLAW_WERKZEUG_ZUSTAND="$BUEHNE/zustand" \
  CLAW_WERKZEUG_LOG="$BUEHNE/log" CLAW_ABBRUCH_FENSTER_MIN=10 bash "$SKRIPT" > "$BUEHNE/ausgabe" 2>&1
pruefe "Abbruch: Fenster einstellbar" "$(ja_wenn "$BUEHNE/aufrufe" "interval '10 minutes'")" "$(grep -o "interval '[0-9]* minutes'" "$BUEHNE/aufrufe" | sort -u | tr '\n' ' ')"

# Hinweis je Art (Durchsicht vom 25.10.2026): zum Anthropic-Konto schicken nur
# guthaben und anfrage_oder_guthaben; die blosse n8n-Meldung zu HTTP 400 heisst
# anfrage_oder_guthaben (21 Zeichen, die Art wird erst nach 30 gekuerzt).
art_meldung() { aufbau ""; abbruch_setzen "1${T}1${T}$1${T}Grund\n"; lauf; }
art_meldung anfrage_oder_guthaben
pruefe "Abbruch, Art anfrage_oder_guthaben: ungekuerzt, ungueltige Anfrage oder Guthaben, Anthropic-Konto" "$( grep -qE 'Art \(vermutet\): anfrage_oder_guthaben\. ' "$BUEHNE/telegram" && grep -q 'leeres Guthaben oder ungueltige Anfrage' "$BUEHNE/telegram" && grep -q 'Anthropic-Konto' "$BUEHNE/telegram" && grep -qF "'[^a-z_]', '', 'g'), 30)" "$BUEHNE/aufrufe" && echo 0 || echo 1 )" "$(cat "$BUEHNE/telegram")"
art_meldung guthaben
pruefe "Abbruch, Art guthaben: leeres Guthaben, Anthropic-Konto" "$(ja_wenn "$BUEHNE/telegram" 'Guthaben beim Anbieter leer; bitte das Anthropic-Konto pruefen')" "$(cat "$BUEHNE/telegram")"
art_meldung schluessel
pruefe "Abbruch, Art schluessel: API-Schluessel, nicht das Konto" "$( grep -q 'API-Schluessel des Claude-Knotens' "$BUEHNE/telegram" && ! grep -q 'Anthropic-Konto' "$BUEHNE/telegram" && echo 0 || echo 1 )" "$(cat "$BUEHNE/telegram")"
art_meldung ueberlast
pruefe "Abbruch, Art ueberlast: Ueberlast beim Anbieter, nicht das Konto" "$( grep -q 'Ueberlast oder Stoerung beim Anbieter' "$BUEHNE/telegram" && ! grep -q 'Anthropic-Konto' "$BUEHNE/telegram" && echo 0 || echo 1 )" "$(cat "$BUEHNE/telegram")"
art_meldung sonst
pruefe "Abbruch, Art sonst: nicht erkannt, kein Satz zum Konto" "$( grep -q 'Art nicht erkannt' "$BUEHNE/telegram" && ! grep -q 'Anthropic-Konto' "$BUEHNE/telegram" && echo 0 || echo 1 )" "$(cat "$BUEHNE/telegram")"

printf '\n%d von %d Pruefungen bestanden\n' "$((GESAMT - FEHLER))" "$GESAMT"
[ "$FEHLER" -eq 0 ]
