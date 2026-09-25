#!/usr/bin/env bash
# Tests fuer ops/claw-wacht.sh, ohne echten Server: "docker" und "curl" sind
# erfundene Befehle, die aus Steuerdateien antworten und ihre Aufrufe mitschreiben.
#
# Die Faelle mit [P] im Namen stellen je einen Befund der adversarialen Pruefung
# vom 25.09.2026 nach (vier Pruefer, 24 Befunde), damit derselbe Fehler nicht
# zurueckkommt.
#
# Aufruf: bash ops/claw-wacht.test.sh
set -uo pipefail

HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKRIPT="$HIER/claw-wacht.sh"
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
rc_ist() { if [ "$(cat "$BUEHNE/rc")" = "$1" ]; then echo 0; else echo 1; fi; }
leer() { if [ -s "$1" ]; then echo 1; else echo 0; fi; }
nicht_leer() { if [ -s "$1" ]; then echo 0; else echo 1; fi; }
datei_weg() { if [ -f "$1" ]; then echo 1; else echo 0; fi; }
datei_da() { if [ -f "$1" ]; then echo 0; else echo 1; fi; }

# $1 = Zeilen "name|zustand|dienst", $2 = Compose-Dienste (soll),
# $3 = Probe (ok|fehler), $4 = Telegram-Antwortcode (Vorgabe 200)
aufbau() {
  BUEHNE=$(mktemp -d)
  mkdir -p "$BUEHNE/bin" "$BUEHNE/projekt" "$BUEHNE/zustand"
  printf '%s\n' "$1" > "$BUEHNE/container"
  printf '%s\n' "$2" > "$BUEHNE/soll"
  printf '%s\n' "$3" > "$BUEHNE/probe"
  printf '%s' "${4:-200}" > "$BUEHNE/tg_code"
  : > "$BUEHNE/aufrufe"
  : > "$BUEHNE/telegram"
  : > "$BUEHNE/einzel"
  printf 'start_hilft=1\ndocker_rc=0\n' > "$BUEHNE/verhalten"
  {
    printf 'TELEGRAM_BOT_TOKEN=%s\n' 'geheim:ABC-123-token'
    printf 'TELEGRAM_CHAT_ID=1810565648\n'
  } > "$BUEHNE/projekt/.env"
  : > "$BUEHNE/projekt/docker-compose.yml"
  schreibe_docker
  schreibe_curl
  chmod +x "$BUEHNE/bin/docker" "$BUEHNE/bin/curl"
}

schreibe_docker() {
  cat > "$BUEHNE/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
B="$BUEHNE"
printf 'docker %s\n' "$*" >> "$B/aufrufe"
. "$B/verhalten"
if printf '%s' "$*" | grep -q -- "config --services"; then
  tr ' ' '\n' < "$B/soll" | sed '/^[[:space:]]*$/d'
  exit 0
fi
unterbefehl=""
for a in "$@"; do
  case "$a" in ps|inspect|start) [ -z "$unterbefehl" ] && unterbefehl="$a" ;; esac
done
case "$unterbefehl" in
  ps)
    if [ "${docker_rc:-0}" != "0" ]; then
      printf 'Cannot connect to the Docker daemon\n' >&2
      exit "${docker_rc:-1}"
    fi
    grep -v '^[[:space:]]*$' "$B/container" 2>/dev/null
    ;;
  inspect)
    name="${@: -1}"
    zeile=$(grep -E "^$name\|" "$B/einzel" 2>/dev/null | head -1)
    if [ -z "$zeile" ]; then
      printf 'Error: No such object: %s\n' "$name" >&2
      exit 1
    fi
    printf '%s\n' "${zeile#*|}"
    ;;
  start)
    namen=""
    for a in "$@"; do
      [ "$a" = "start" ] && continue
      [ "${a#-}" = "$a" ] && namen="$namen $a"
    done
    if [ "${start_hilft:-1}" != "1" ]; then
      printf 'Error response from daemon: start fehlgeschlagen\n' >&2
      exit 1
    fi
    for n in $namen; do
      awk -F'|' -v n="$n" 'BEGIN{OFS="|"} {if ($1==n) $2="running"; print}' "$B/container" > "$B/c.neu" && mv "$B/c.neu" "$B/container"
      awk -F'|' -v n="$n" 'BEGIN{OFS="|"} {if ($1==n) $2="running"; print}' "$B/einzel" > "$B/e.neu" && mv "$B/e.neu" "$B/einzel"
      printf '%s\n' "$n"
    done
    ;;
  *) exit 0 ;;
esac
DOCKER
}

schreibe_curl() {
  cat > "$BUEHNE/bin/curl" <<'CURL'
#!/usr/bin/env bash
B="$BUEHNE"
printf 'curl %s\n' "$*" >> "$B/aufrufe"
ziel=""
for ((i=1; i<=$#; i++)); do
  if [ "${!i}" = "--config" ]; then
    j=$((i+1)); ziel=$(cat "${!j}" 2>/dev/null)
  fi
done
if printf '%s %s' "$*" "$ziel" | grep -q "api.telegram.org"; then
  printf '%s\n' "$*" >> "$B/telegram"
  cat "$B/tg_code"
  exit 0
fi
if [ "$(cat "$B/probe")" = "ok" ]; then printf '200'; else printf '000'; fi
CURL
}

lauf() { # zusaetzliche Umgebung als Argumente, z.B. lauf CLAW_NUR_MELDEN=1
  env BUEHNE="$BUEHNE" PATH="$BUEHNE/bin:$PATH" \
    CLAW_PROJEKT="$BUEHNE/projekt" \
    CLAW_PROJEKTNAME=testprojekt \
    CLAW_ZUSTAND_DIR="${ZDIR:-$BUEHNE/zustand}" \
    CLAW_ZUSTAND_AUSWEICH="${ZAUS:-$BUEHNE/zustand2}" \
    CLAW_LOG="$BUEHNE/log" \
    CLAW_NACHPRUEF_S=0 \
    CLAW_EINZELCONTAINER="${EINZEL_LISTE-}" \
    "$@" bash "$SKRIPT" > "$BUEHNE/ausgabe" 2>&1
  printf '%s' "$?" > "$BUEHNE/rc"
}

abbau() { rm -rf "$BUEHNE"; unset EINZEL_LISTE ZDIR ZAUS; }

Z() { printf '%s' "${ZDIR:-$BUEHNE/zustand}"; }

echo "=== 1: alles laeuft ==="
aufbau "n8n-claw|running|n8n
n8n-claw-rest|running|rest" "n8n rest" ok
lauf
pruefe "Rueckgabe 0" "$(rc_ist 0)" "rc=$(cat "$BUEHNE/rc")"
pruefe "kein docker start" "$(nein_wenn "$BUEHNE/aufrufe" 'docker start')" "$(grep start "$BUEHNE/aufrufe")"
pruefe "keine Meldung" "$(leer "$BUEHNE/telegram")" "$(cat "$BUEHNE/telegram")"
pruefe "Journal sagt: alles in Ordnung" "$(ja_wenn "$BUEHNE/ausgabe" 'alles in Ordnung')" "$(cat "$BUEHNE/ausgabe")"
pruefe "kein Logfile auf gesundem Server" "$(datei_weg "$BUEHNE/log")" "$(cat "$BUEHNE/log" 2>/dev/null)"
pruefe "[P] keine Fehlermeldung im Journal" "$(nein_wenn "$BUEHNE/ausgabe" 'No such file|Datei oder Verzeichnis')" "$(cat "$BUEHNE/ausgabe")"
abbau

echo "=== 2 und 3: gestoppter Container, erst beobachten, dann starten ==="
aufbau "n8n-claw|running|n8n
n8n-claw-rest|exited|rest" "n8n rest" ok
lauf
pruefe "erster Lauf greift nicht ein" "$(nein_wenn "$BUEHNE/aufrufe" 'docker start')" "$(grep start "$BUEHNE/aufrufe")"
pruefe "Befund nennt den Container" "$(ja_wenn "$BUEHNE/log" 'gestoppt: n8n-claw-rest')" "$(cat "$BUEHNE/log")"
pruefe "Rueckgabe 0 beim Beobachten" "$(rc_ist 0)" "rc=$(cat "$BUEHNE/rc")"
lauf
pruefe "zweiter Lauf startet genau diesen Container" "$(ja_wenn "$BUEHNE/aufrufe" 'docker start n8n-claw-rest$')" "$(grep start "$BUEHNE/aufrufe")"
pruefe "[P] kein compose up" "$(nein_wenn "$BUEHNE/aufrufe" 'up -d')" "$(grep up "$BUEHNE/aufrufe")"
pruefe "Log sagt behoben" "$(ja_wenn "$BUEHNE/log" 'behoben')" "$(tail -4 "$BUEHNE/log")"
pruefe "Meldung zugestellt" "$(nicht_leer "$BUEHNE/telegram")" ""
pruefe "Rueckgabe 0" "$(rc_ist 0)" "rc=$(cat "$BUEHNE/rc")"
pruefe "Zaehler weg" "$(datei_weg "$(Z)/fehlversuche")" ""
pruefe "[P] Eingriffsfenster ueberlebt die Erholung" "$(datei_da "$(Z)/eingriffe_fenster")" "$(ls "$(Z)")"
pruefe "[P] Token nicht in der Befehlszeile" "$(nein_wenn "$BUEHNE/aufrufe" 'geheim:ABC')" "$(grep -c geheim "$BUEHNE/aufrufe")"
pruefe "Token kam per --config" "$(ja_wenn "$BUEHNE/aufrufe" '[-][-]config')" ""
pruefe "[P] Token-Datei aufgeraeumt" "$([ -z "$(ls "$(Z)"/.telegram.* 2>/dev/null)" ] && echo 0 || echo 1)" "$(ls -a "$(Z)")"
abbau

echo "=== 4: [P] Messung scheitert, das ist NICHT 'alles tot' ==="
aufbau "n8n-claw|running|n8n
n8n-claw-rest|running|rest" "n8n rest" ok
printf 'start_hilft=1\ndocker_rc=1\n' > "$BUEHNE/verhalten"
lauf
lauf
pruefe "Befund: nicht messbar" "$(ja_wenn "$BUEHNE/log" 'nicht messbar')" "$(tail -3 "$BUEHNE/log")"
pruefe "KEIN docker start ueber den ganzen Stapel" "$(nein_wenn "$BUEHNE/aufrufe" 'docker start')" "$(grep start "$BUEHNE/aufrufe")"
pruefe "Rueckgabe 1" "$(rc_ist 1)" "rc=$(cat "$BUEHNE/rc")"
abbau

echo "=== 5: leere Messung gilt auch als nicht messbar ==="
aufbau "" "n8n rest" ok
lauf
lauf
pruefe "Befund: nicht messbar" "$(ja_wenn "$BUEHNE/log" 'nicht messbar')" "$(tail -3 "$BUEHNE/log")"
pruefe "kein docker start" "$(nein_wenn "$BUEHNE/aufrufe" 'docker start')" "$(grep start "$BUEHNE/aufrufe")"
abbau

echo "=== 6: [P] wechselnder Befundtext zaehlt weiter ==="
aufbau "n8n-claw|running|n8n
n8n-claw-rest|exited|rest" "n8n rest" ok
lauf
printf 'n8n-claw|running|n8n\nn8n-claw-rest|exited|rest\nn8n-claw-kong|exited|kong\n' > "$BUEHNE/container"
printf '%s\n' "n8n rest kong" > "$BUEHNE/soll"
lauf
pruefe "trotz neuem Text wird im zweiten Lauf eingegriffen" "$(ja_wenn "$BUEHNE/aufrufe" 'docker start')" "$(grep start "$BUEHNE/aufrufe")"
pruefe "beide Container gestartet" "$(ja_wenn "$BUEHNE/aufrufe" 'docker start n8n-claw-rest n8n-claw-kong')" "$(grep start "$BUEHNE/aufrufe")"
abbau

echo "=== 7: [P] restarting ist Dockers eigene Schleife ==="
aufbau "n8n-claw|running|n8n
n8n-claw-rest|restarting|rest" "n8n rest" ok
lauf
lauf
pruefe "kein docker start" "$(nein_wenn "$BUEHNE/aufrufe" 'docker start')" "$(grep start "$BUEHNE/aufrufe")"
pruefe "Befund nennt: in Bewegung" "$(ja_wenn "$BUEHNE/log" 'in Bewegung: n8n-claw-rest')" "$(tail -3 "$BUEHNE/log")"
pruefe "Rueckgabe 1, das braucht einen Menschen" "$(rc_ist 1)" "rc=$(cat "$BUEHNE/rc")"
abbau

echo "=== 8: Probe faellt aus, alles laeuft: nur melden ==="
aufbau "n8n-claw|running|n8n
n8n-claw-rest|running|rest" "n8n rest" fehler
lauf
lauf
pruefe "kein Eingriff" "$(nein_wenn "$BUEHNE/aufrufe" 'docker start')" "$(grep start "$BUEHNE/aufrufe")"
pruefe "Befund nennt PostgREST" "$(ja_wenn "$BUEHNE/log" 'PostgREST antwortet nicht')" "$(tail -3 "$BUEHNE/log")"
pruefe "Rueckgabe 1" "$(rc_ist 1)" "rc=$(cat "$BUEHNE/rc")"
pruefe "Meldung zugestellt" "$(nicht_leer "$BUEHNE/telegram")" ""

echo "=== 9: [P] unveraenderter Dauerbefund wird nur einmal gemeldet ==="
: > "$BUEHNE/telegram"
lauf
pruefe "keine zweite Meldung" "$(leer "$BUEHNE/telegram")" "$(cat "$BUEHNE/telegram")"
pruefe "Log sagt: schon gemeldet" "$(ja_wenn "$BUEHNE/log" 'schon gemeldet')" "$(tail -3 "$BUEHNE/log")"
abbau

echo "=== 10: [P] fehlender Einzelcontainer verdeckt die Probe nicht ==="
aufbau "n8n-claw|running|n8n" "n8n" fehler
EINZEL_LISTE="slt-frontend"
: > "$BUEHNE/einzel"
lauf
lauf
pruefe "Befund nennt den fehlenden Container" "$(ja_wenn "$BUEHNE/log" 'gar nicht vorhanden: slt-frontend')" "$(tail -3 "$BUEHNE/log")"
pruefe "Befund nennt ZUSAETZLICH die Probe" "$(ja_wenn "$BUEHNE/log" 'vorhanden: slt-frontend; PostgREST antwortet nicht')" "$(grep Befund "$BUEHNE/log" | tail -1)"
pruefe "kein docker start" "$(nein_wenn "$BUEHNE/aufrufe" 'docker start')" "$(grep start "$BUEHNE/aufrufe")"
abbau

echo "=== 11: Einzelcontainer gestoppt wird gestartet ==="
aufbau "n8n-claw|running|n8n" "n8n" ok
EINZEL_LISTE="slt-frontend teams-bridge"
printf 'slt-frontend|exited\nteams-bridge|running\n' > "$BUEHNE/einzel"
lauf
lauf
pruefe "genau der Webchat wird gestartet" "$(ja_wenn "$BUEHNE/aufrufe" 'docker start slt-frontend$')" "$(grep start "$BUEHNE/aufrufe")"
pruefe "Log sagt behoben" "$(ja_wenn "$BUEHNE/log" 'behoben')" "$(tail -3 "$BUEHNE/log")"
pruefe "Rueckgabe 0" "$(rc_ist 0)" "rc=$(cat "$BUEHNE/rc")"
abbau

echo "=== 12: [P] Telegram nicht zugestellt: keine Drosselung, keine Entwarnung ==="
aufbau "n8n-claw|running|n8n
n8n-claw-rest|running|rest" "n8n rest" fehler 401
lauf
lauf
pruefe "Log sagt: NICHT zugestellt" "$(ja_wenn "$BUEHNE/log" 'NICHT zugestellt')" "$(tail -3 "$BUEHNE/log")"
pruefe "kein Drosselstempel gesetzt" "$(datei_weg "$(Z)/letzte_meldung")" "$(cat "$(Z)/letzte_meldung" 2>/dev/null)"
pruefe "kein Entwarnungsmarker" "$(datei_weg "$(Z)/gemeldet")" ""
: > "$BUEHNE/telegram"
lauf
pruefe "naechster Lauf versucht es wieder" "$(nicht_leer "$BUEHNE/telegram")" "$(cat "$BUEHNE/telegram")"
abbau

echo "=== 13: [P] Deckel gegen die Absturzschleife ==="
aufbau "n8n-claw|running|n8n
n8n-claw-rest|exited|rest" "n8n rest" ok
printf '%s 5' "$(date +%s)" > "$BUEHNE/zustand/eingriffe_fenster"
lauf
lauf
pruefe "kein Start mehr nach 5 Versuchen in 24 h" "$(nein_wenn "$BUEHNE/aufrufe" 'docker start')" "$(grep start "$BUEHNE/aufrufe")"
pruefe "Log sagt: ich hoere auf" "$(ja_wenn "$BUEHNE/log" 'hoere auf')" "$(tail -3 "$BUEHNE/log")"
pruefe "Rueckgabe 1" "$(rc_ist 1)" "rc=$(cat "$BUEHNE/rc")"
pruefe "Meldung zugestellt" "$(nicht_leer "$BUEHNE/telegram")" ""
abbau

echo "=== 14: abgelaufenes Fenster erlaubt wieder einen Start ==="
aufbau "n8n-claw|running|n8n
n8n-claw-rest|exited|rest" "n8n rest" ok
printf '%s 5' "$(( $(date +%s) - 90000 ))" > "$BUEHNE/zustand/eingriffe_fenster"
lauf
lauf
pruefe "Start erlaubt" "$(ja_wenn "$BUEHNE/aufrufe" 'docker start n8n-claw-rest')" "$(grep start "$BUEHNE/aufrufe")"
abbau

echo "=== 15: [P] kein beschreibbarer Zustandsordner: nichts tun, sichtbar scheitern ==="
aufbau "n8n-claw|running|n8n
n8n-claw-rest|exited|rest" "n8n rest" ok
: > "$BUEHNE/blocker"
ZDIR="$BUEHNE/blocker/zustand"
ZAUS="$BUEHNE/blocker/ausweich"
lauf
pruefe "kein Eingriff ohne Gedaechtnis" "$(nein_wenn "$BUEHNE/aufrufe" 'docker start')" "$(grep start "$BUEHNE/aufrufe")"
pruefe "Log sagt: kein beschreibbarer Zustandsordner" "$(ja_wenn "$BUEHNE/log" 'kein beschreibbarer Zustandsordner')" "$(cat "$BUEHNE/log")"
pruefe "Rueckgabe 1" "$(rc_ist 1)" "rc=$(cat "$BUEHNE/rc")"
pruefe "keine Telegram-Meldung ohne Drosselgedaechtnis" "$(leer "$BUEHNE/telegram")" "$(cat "$BUEHNE/telegram")"
abbau

echo "=== 16: [P] verschwundener Dienst wird nicht verschluckt ==="
aufbau "n8n-claw|running|n8n" "n8n rest" ok
lauf
lauf
pruefe "Befund nennt den verschwundenen Dienst" "$(ja_wenn "$BUEHNE/log" 'Container verschwunden: rest')" "$(tail -3 "$BUEHNE/log")"
pruefe "kein docker start" "$(nein_wenn "$BUEHNE/aufrufe" 'docker start')" "$(grep start "$BUEHNE/aufrufe")"
pruefe "Rueckgabe 1" "$(rc_ist 1)" "rc=$(cat "$BUEHNE/rc")"
abbau

echo "=== 17: Ignorierliste unterdrueckt einen absichtlich fehlenden Dienst ==="
aufbau "n8n-claw|running|n8n" "n8n discord-bridge" ok
lauf CLAW_IGNORIEREN=discord-bridge
pruefe "kein Befund" "$(datei_weg "$BUEHNE/log")" "$(cat "$BUEHNE/log" 2>/dev/null)"
pruefe "Journal sagt: alles in Ordnung" "$(ja_wenn "$BUEHNE/ausgabe" 'alles in Ordnung')" "$(cat "$BUEHNE/ausgabe")"
abbau

echo "=== 18: Pausenbremse ==="
aufbau "n8n-claw|running|n8n
n8n-claw-rest|exited|rest" "n8n rest" ok
: > "$BUEHNE/PAUSE"
lauf CLAW_PAUSE_DATEI="$BUEHNE/PAUSE"
lauf CLAW_PAUSE_DATEI="$BUEHNE/PAUSE"
pruefe "kein Start" "$(nein_wenn "$BUEHNE/aufrufe" 'docker start')" "$(grep start "$BUEHNE/aufrufe")"
pruefe "keine Meldung" "$(leer "$BUEHNE/telegram")" ""
pruefe "Journal nennt die Pause" "$(ja_wenn "$BUEHNE/ausgabe" 'Pause')" "$(cat "$BUEHNE/ausgabe")"
pruefe "kein Zaehler angelegt" "$(datei_weg "$(Z)/fehlversuche")" ""
pruefe "Rueckgabe 0" "$(rc_ist 0)" "rc=$(cat "$BUEHNE/rc")"
rm -f "$BUEHNE/PAUSE"
lauf CLAW_PAUSE_DATEI="$BUEHNE/PAUSE"
pruefe "nach dem Loeschen arbeitet er wieder" "$(ja_wenn "$BUEHNE/log" 'gestoppt: n8n-claw-rest')" "$(cat "$BUEHNE/log")"
abbau

echo "=== 19: Probemodus greift nicht ein ==="
aufbau "n8n-claw|running|n8n
n8n-claw-rest|exited|rest" "n8n rest" ok
lauf CLAW_NUR_MELDEN=1
lauf CLAW_NUR_MELDEN=1
pruefe "kein Start" "$(nein_wenn "$BUEHNE/aufrufe" 'docker start')" "$(grep start "$BUEHNE/aufrufe")"
pruefe "Log sagt Probemodus" "$(ja_wenn "$BUEHNE/log" 'Probemodus')" "$(tail -3 "$BUEHNE/log")"
pruefe "kein Eingriff im Fenster vermerkt" "$(datei_weg "$(Z)/eingriffe_fenster")" "$(cat "$(Z)/eingriffe_fenster" 2>/dev/null)"
pruefe "Rueckgabe 0" "$(rc_ist 0)" "rc=$(cat "$BUEHNE/rc")"
abbau

echo "=== 20: ohne Telegram-Zugang laeuft er weiter ==="
aufbau "n8n-claw|running|n8n
n8n-claw-rest|exited|rest" "n8n rest" ok
: > "$BUEHNE/projekt/.env"
lauf
lauf
pruefe "Log sagt: kein Telegram-Zugang" "$(ja_wenn "$BUEHNE/log" 'kein Telegram-Zugang')" "$(tail -4 "$BUEHNE/log")"
pruefe "Start trotzdem ausgefuehrt" "$(ja_wenn "$BUEHNE/aufrufe" 'docker start n8n-claw-rest')" "$(grep start "$BUEHNE/aufrufe")"
pruefe "Rueckgabe 0" "$(rc_ist 0)" "rc=$(cat "$BUEHNE/rc")"
abbau

echo "=== 21: Start scheitert: melden, nicht behaupten ==="
aufbau "n8n-claw|running|n8n
n8n-claw-rest|exited|rest" "n8n rest" ok
printf 'start_hilft=0\ndocker_rc=0\n' > "$BUEHNE/verhalten"
lauf
lauf
pruefe "Log sagt: hat nicht geholfen" "$(ja_wenn "$BUEHNE/log" 'nicht geholfen')" "$(tail -3 "$BUEHNE/log")"
pruefe "Rueckgabe 1" "$(rc_ist 1)" "rc=$(cat "$BUEHNE/rc")"
pruefe "Meldung zugestellt" "$(nicht_leer "$BUEHNE/telegram")" ""
pruefe "keine Entwarnung behauptet" "$(nein_wenn "$BUEHNE/telegram" 'wieder.in.Ordnung')" "$(cat "$BUEHNE/telegram")"
abbau

echo "=== 22: [P] Entwarnung stellt die Drossel-Uhr nicht ==="
aufbau "n8n-claw|running|n8n
n8n-claw-rest|exited|rest" "n8n rest" ok
lauf
lauf
pruefe "Entwarnung ging raus" "$(ja_wenn "$BUEHNE/telegram" 'wieder.gestartet')" "$(cat "$BUEHNE/telegram")"
pruefe "kein Drosselstempel durch die Entwarnung" "$(datei_weg "$(Z)/letzte_meldung")" "$(cat "$(Z)/letzte_meldung" 2>/dev/null)"
# Direkt danach ein echter Alarm: alles laeuft, aber die Probe faellt aus.
printf 'fehler\n' > "$BUEHNE/probe"
: > "$BUEHNE/telegram"
lauf
lauf
pruefe "echter Alarm kurz nach der Entwarnung kommt an" "$(nicht_leer "$BUEHNE/telegram")" "$(tail -3 "$BUEHNE/log")"
pruefe "Alarm nicht gedrosselt" "$(nein_wenn "$BUEHNE/log" 'gedrosselt')" "$(tail -4 "$BUEHNE/log")"
abbau

echo "=== 23: [P] flatternder Container: hoechstens 5 Starts, dann Mensch ==="
aufbau "n8n-claw|running|n8n
n8n-claw-rest|exited|rest" "n8n rest" ok
printf 'start_hilft=0\ndocker_rc=0\n' > "$BUEHNE/verhalten"
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do lauf; done
starts=$(grep -c 'docker start' "$BUEHNE/aufrufe")
pruefe "nicht mehr als 5 Startversuche in 12 Laeufen" "$([ "$starts" -le 5 ] && echo 0 || echo 1)" "Starts: $starts"
pruefe "mindestens ein Startversuch" "$([ "$starts" -ge 1 ] && echo 0 || echo 1)" "Starts: $starts"
pruefe "Log sagt am Ende: ich hoere auf" "$(ja_wenn "$BUEHNE/log" 'hoere auf')" "$(tail -3 "$BUEHNE/log")"
pruefe "Rueckgabe 1" "$(rc_ist 1)" "rc=$(cat "$BUEHNE/rc")"
pruefe "der Mensch wurde gerufen" "$(nicht_leer "$BUEHNE/telegram")" ""
pruefe "keine Entwarnung behauptet" "$(nein_wenn "$BUEHNE/telegram" 'wieder.in.Ordnung|wieder.gestartet')" "$(cat "$BUEHNE/telegram")"
abbau

printf '\n%s von %s Faellen bestanden\n' "$((GESAMT - FEHLER))" "$GESAMT"
[ "$FEHLER" -eq 0 ] || exit 1
