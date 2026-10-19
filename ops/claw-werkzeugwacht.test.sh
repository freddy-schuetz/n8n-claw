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
case "$*" in *"ohne Eingabe"*) cat "$BUEHNE/leer" ;; *) cat "$BUEHNE/tabelle" ;; esac
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

printf '\n%d von %d Pruefungen bestanden\n' "$((GESAMT - FEHLER))" "$GESAMT"
[ "$FEHLER" -eq 0 ]
