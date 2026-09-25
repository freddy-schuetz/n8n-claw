#!/usr/bin/env bash
# Waechter fuer den Docker-Stapel des SLT-Agenten.
#
# Anlass (25.09.2026): Ein harter Host-Neustart um 04:00 hat den Container
# n8n-claw-rest (PostgREST) liegen gelassen. Docker scheiterte beim
# Wiederherstellen ("layer not mounted"), setzte Exit 255 und gab auf.
# "restart: unless-stopped" greift in diesem Fall nicht, weil Docker den
# Neustart selbst als gescheitert abhakt.
#
# Die Folge war unsichtbar und total: Kong konnte den Namen "rest" nicht mehr
# aufloesen und lieferte auf jeden Aufruf von /rest/v1/... eine 503. Weil jede
# Agenten-Ausfuehrung Seele, Konfiguration und Profil ueber PostgREST laedt,
# starb sie sofort. Acht Stunden, 530 gescheiterte Ausfuehrungen, aufgefallen
# erst, als eine Nutzerin fragte, was mit Rupert los sei.
#
# Vier Regeln halten den Waechter harmlos:
#   1. Er startet nur Container, die EXISTIEREN und GESTOPPT sind, und zwar mit
#      "docker start". Das kann nichts neu bauen, nichts ziehen und keinen
#      Nachbarn anfassen. Kein compose up, kein restart, kein down.
#   2. Er handelt erst, wenn zwei Laeufe hintereinander einen Befund sehen, also
#      rund vier Minuten nach dem Ausfall.
#   3. Er gibt nach wenigen erfolglosen Versuchen auf und ruft einen Menschen,
#      statt endlos weiterzustarten.
#   4. Liegt die Pausendatei, tut er gar nichts. Wer von Hand arbeitet, gewinnt.
#
# Was er NICHT tut: einen laufenden Container anfassen, einen Container
# wiederherstellen, der gar nicht mehr existiert, oder in Dockers eigene
# Neustartschleife (Status "restarting") hineinpfuschen. In all diesen Faellen
# meldet er und laesst den Eingriff einem Menschen.
#
# Rueckgabe: 0 wenn alles in Ordnung ist, der Befund behoben wurde oder noch
# beobachtet wird. 1 wenn etwas einen Menschen braucht. Dann steht die Einheit
# in "systemctl --failed".
set -uo pipefail

PROJEKT="${CLAW_PROJEKT:-/root/n8n-claw}"
PROJEKTNAME="${CLAW_PROJEKTNAME:-$(basename "$PROJEKT")}"
# Container, die NICHT zum Compose-Stapel gehoeren, aber genauso wichtig sind:
# der Webchat und die Teams-Bruecke laufen als eigene "docker run"-Container.
EINZELCONTAINER="${CLAW_EINZELCONTAINER-slt-frontend teams-bridge}"
ZUSTAND_DIR="${CLAW_ZUSTAND_DIR:-/var/lib/claw-wacht}"
ZUSTAND_AUSWEICH="${CLAW_ZUSTAND_AUSWEICH:-/run/claw-wacht}"
LOG="${CLAW_LOG:-/var/log/claw-wacht.log}"
LOG_ZEILEN="${CLAW_LOG_ZEILEN:-10000}"
PROBE_URL="${CLAW_PROBE_URL:-http://127.0.0.1:3000/}"
PROBE_TIMEOUT="${CLAW_PROBE_TIMEOUT:-10}"
SCHWELLE="${CLAW_SCHWELLE:-2}"
# Deckel gegen die Absturzschleife: ein Container, der nach jedem Start wieder
# stirbt, wuerde sonst ewig neu gestartet, weil jede erfolgreiche Erholung den
# Zaehler loescht. Dieses Fenster ueberlebt die Erholung ausdruecklich.
MAX_EINGRIFFE_24H="${CLAW_MAX_EINGRIFFE_24H:-5}"
FENSTER_S="${CLAW_FENSTER_S:-86400}"
# Compose-Dienste, die absichtlich keinen Container haben (etwa nie benutzte
# Profile), damit sie nicht als verschwunden gemeldet werden.
IGNORIEREN="${CLAW_IGNORIEREN-}"
MELDE_ABSTAND_S="${CLAW_MELDE_ABSTAND_S:-3600}"
NUR_MELDEN="${CLAW_NUR_MELDEN:-0}"
PROBE_ERZWINGEN="${CLAW_PROBE_ERZWINGEN:-}"
NACHPRUEF_S="${CLAW_NACHPRUEF_S:-30}"   # lange genug, damit ein Container, der gleich wieder stirbt, auffaellt
PAUSE_DATEI="${CLAW_PAUSE_DATEI:-$PROJEKT/ops/PAUSE}"
TELEGRAM_CHAT_ID_VORGABE="${CLAW_TELEGRAM_CHAT_ID:-}"

TG_DATEI=""
# Die Datei mit dem Bot-Token darf auch bei einem Abbruch nicht liegenbleiben
# (systemd schickt SIGTERM, wenn der Lauf zu lange dauert). Der Rumpf endet mit
# einem wahren Befehl, damit der Rueckgabewert des Skripts unberuehrt bleibt.
aufraeumen() { if [ -n "$TG_DATEI" ]; then rm -f "$TG_DATEI" 2>/dev/null; fi; : ; }
trap aufraeumen EXIT
trap 'aufraeumen; exit 143' INT TERM

nur_journal() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }

log() {
  local zeile
  zeile="$(date -u '+%Y-%m-%dT%H:%M:%SZ') $*"
  printf '%s\n' "$zeile"
  printf '%s\n' "$zeile" >> "$LOG" 2>/dev/null || true
}

log_kuerzen() {
  local n
  [ -f "$LOG" ] || return 0
  n=$(wc -l < "$LOG" 2>/dev/null || echo 0)
  if [ "${n:-0}" -gt "$LOG_ZEILEN" ]; then
    tail -n "$LOG_ZEILEN" "$LOG" > "$LOG.neu" 2>/dev/null && mv "$LOG.neu" "$LOG" 2>/dev/null
  fi
}

# --- Zustandsordner. Ohne Gedaechtnis darf der Waechter nicht handeln: er
# koennte weder zwei Laeufe zaehlen noch Versuche begrenzen noch Meldungen
# drosseln. Dann meldet er nur ins Journal und gibt 1 zurueck, damit die
# Einheit als gescheitert sichtbar wird.
zustand_pruefen() {
  local d
  for d in "$ZUSTAND_DIR" "$ZUSTAND_AUSWEICH"; do
    if mkdir -p "$d" 2>/dev/null && : > "$d/.schreibprobe" 2>/dev/null; then
      rm -f "$d/.schreibprobe" 2>/dev/null
      ZUSTAND_DIR="$d"
      return 0
    fi
  done
  return 1
}

if zustand_pruefen; then
  ZUSTAND_OK=1
else
  ZUSTAND_OK=0
fi
Z_ZAEHLER="$ZUSTAND_DIR/fehlversuche"
Z_FENSTER="$ZUSTAND_DIR/eingriffe_fenster"
Z_BEFUND="$ZUSTAND_DIR/letzter_befund"
Z_MELDUNG="$ZUSTAND_DIR/letzte_meldung"
Z_GEMELDET="$ZUSTAND_DIR/gemeldet"
Z_SPERRE="$ZUSTAND_DIR/sperre"
# Liegengebliebene Token-Dateien eines abgebrochenen Laufs aufraeumen.
rm -f "$ZUSTAND_DIR"/.telegram.* 2>/dev/null

# --- Pausenbremse: wer von Hand an den Containern arbeitet, legt die Datei an.
#   touch /root/n8n-claw/ops/PAUSE   (und wieder loeschen, wenn fertig)
if [ -f "$PAUSE_DATEI" ]; then
  nur_journal "Pause: $PAUSE_DATEI liegt da, ich greife nicht ein"
  exit 0
fi

# --- Nur ein Lauf zur Zeit, sonst ueberschreiben sich zwei Laeufe die Zaehler.
# Erst pruefen, ob die Datei beschreibbar ist: ein fehlgeschlagenes "exec" mit
# Umleitung wuerde das Skript sonst sofort beenden.
if [ "$ZUSTAND_OK" = "1" ] && command -v flock >/dev/null 2>&1 && : > "$Z_SPERRE" 2>/dev/null; then
  exec 9>>"$Z_SPERRE"
  if ! flock -n 9; then
    nur_journal "ein Lauf ist noch unterwegs, dieser tritt zurueck"
    exit 0
  fi
fi

# --- Messen. Setzt:
#   M_MESSBAR    1 oder 0 (0 = wir wissen nichts, also niemals handeln)
#   M_GESTOPPT   Container, die existieren und gestoppt sind (exited/created/dead)
#   M_UEBERGANG  Container in Bewegung (restarting/removing/paused): nur beobachten
#   M_FEHLT      erwartete Container, die es gar nicht gibt
#   M_PROBE      ok oder fehler
M_MESSBAR=0
M_GESTOPPT=""
M_UEBERGANG=""
M_FEHLT=""
M_VERSCHWUNDEN=""
M_PROBE="ok"

messen() {
  M_MESSBAR=0
  M_GESTOPPT=""
  M_UEBERGANG=""
  M_FEHLT=""
  M_VERSCHWUNDEN=""
  local zeilen rc name zustand dienst c gesehen soll s

  # Compose-Container ueber das Projekt-Label, nicht ueber "docker compose ps".
  # So haengt die Messung an einem einzigen Aufruf, dessen Rueckgabewert wir
  # pruefen koennen, und wir sehen den echten Zustand je Container.
  zeilen=$(docker ps -a --filter "label=com.docker.compose.project=$PROJEKTNAME" \
            --format '{{.Names}}|{{.State}}|{{.Label "com.docker.compose.service"}}' 2>/dev/null)
  rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$zeilen" ]; then
    return 0   # nicht messbar: M_MESSBAR bleibt 0
  fi

  gesehen=""
  while IFS='|' read -r name zustand dienst; do
    [ -z "$name" ] && continue
    [ -n "$dienst" ] && gesehen="$gesehen $dienst"
    case "$zustand" in
      running) ;;
      exited|created|dead) M_GESTOPPT="$M_GESTOPPT $name" ;;
      restarting|removing|paused) M_UEBERGANG="$M_UEBERGANG $name" ;;
      *) M_UEBERGANG="$M_UEBERGANG $name" ;;
    esac
  done <<< "$zeilen"

  # Ein Dienst, dessen Container ganz verschwunden ist (gescheitertes Recreate,
  # "docker rm", prune), taucht oben gar nicht auf. Ohne diesen Vergleich waere
  # er unsichtbar und der Waechter wuerde "alles in Ordnung" melden.
  soll=$(docker compose -f "$PROJEKT/docker-compose.yml" --project-directory "$PROJEKT" \
          config --services 2>/dev/null)
  rc=$?
  if [ "$rc" -eq 0 ] && [ -n "$soll" ]; then
    for s in $soll; do
      case " $gesehen " in *" $s "*) continue ;; esac
      case " $IGNORIEREN " in *" $s "*) continue ;; esac
      M_VERSCHWUNDEN="$M_VERSCHWUNDEN $s"
    done
  fi
  M_VERSCHWUNDEN="${M_VERSCHWUNDEN# }"

  # Einzelcontainer ausserhalb von Compose.
  for c in $EINZELCONTAINER; do
    zustand=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null)
    rc=$?
    if [ "$rc" -ne 0 ] || [ -z "$zustand" ]; then
      M_FEHLT="$M_FEHLT $c"
      continue
    fi
    case "$zustand" in
      running) ;;
      exited|created|dead) M_GESTOPPT="$M_GESTOPPT $c" ;;
      *) M_UEBERGANG="$M_UEBERGANG $c" ;;
    esac
  done

  M_GESTOPPT="${M_GESTOPPT# }"
  M_UEBERGANG="${M_UEBERGANG# }"
  M_FEHLT="${M_FEHLT# }"
  M_MESSBAR=1

  # Die Probe wird IMMER gemessen, nie von einem anderen Befund verdeckt.
  if probe_ok; then M_PROBE="ok"; else M_PROBE="fehler"; fi
  return 0
}

probe_ok() {
  [ "$PROBE_ERZWINGEN" = "fehler" ] && return 1
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$PROBE_TIMEOUT" "$PROBE_URL" 2>/dev/null || true)
  [ "$code" = "200" ]
}

befund_bauen() {
  local teile=""
  if [ "$M_MESSBAR" = "0" ]; then
    printf '%s' "Lage nicht messbar (antwortet Docker? stimmt der Projektname $PROJEKTNAME?)"
    return 0
  fi
  [ -n "$M_GESTOPPT" ] && teile="gestoppt: $M_GESTOPPT"
  if [ -n "$M_FEHLT" ]; then
    [ -n "$teile" ] && teile="$teile; "
    teile="${teile}gar nicht vorhanden: $M_FEHLT"
  fi
  if [ -n "$M_VERSCHWUNDEN" ]; then
    [ -n "$teile" ] && teile="$teile; "
    teile="${teile}Container verschwunden: $M_VERSCHWUNDEN"
  fi
  if [ -n "$M_UEBERGANG" ]; then
    [ -n "$teile" ] && teile="$teile; "
    teile="${teile}in Bewegung: $M_UEBERGANG"
  fi
  if [ "$M_PROBE" = "fehler" ]; then
    [ -n "$teile" ] && teile="$teile; "
    teile="${teile}PostgREST antwortet nicht auf $PROBE_URL"
  fi
  printf '%s' "$teile"
}

# Gibt die Chat-Kennung aus und legt den Token in eine Datei mit Modus 600,
# damit er nie in der Prozessliste steht: curl liest ihn per --config.
telegram_vorbereiten() {
  local datei="$1" token chat
  token=$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' "$PROJEKT/.env" 2>/dev/null | head -1 | tr -d '"'"'"' \t\r')
  chat="$TELEGRAM_CHAT_ID_VORGABE"
  [ -z "$chat" ] && chat=$(sed -n 's/^TELEGRAM_CHAT_ID=//p' "$PROJEKT/.env" 2>/dev/null | head -1 | tr -d '"'"'"' \t\r')
  if [ -z "$token" ] || [ -z "$chat" ]; then return 1; fi
  ( umask 177; printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$token" > "$datei" ) 2>/dev/null || return 1
  printf '%s' "$chat"
}

# Rueckgabe 0 nur, wenn die Meldung wirklich zugestellt wurde. Nur dann werden
# Drosselung und Entwarnungsmarker gesetzt: eine nicht zugestellte Meldung darf
# die naechste Stunde nicht stumm schalten.
melden() {
  local text="$1" sofort="${2:-}" jetzt letzte chat code
  jetzt=$(date +%s)
  letzte=$(cat "$Z_MELDUNG" 2>/dev/null || echo 0)
  case "$letzte" in ''|*[!0-9]*) letzte=0 ;; esac
  if [ "$ZUSTAND_OK" = "0" ]; then
    log "kein Gedaechtnis vorhanden, ich melde nur ins Journal: $text"
    return 1
  fi
  if [ "$sofort" != "sofort" ] && [ $((jetzt - letzte)) -lt "$MELDE_ABSTAND_S" ]; then
    log "Meldung gedrosselt (letzte vor $((jetzt - letzte)) s): $text"
    return 1
  fi
  TG_DATEI="$ZUSTAND_DIR/.telegram.$$"
  if ! chat=$(telegram_vorbereiten "$TG_DATEI"); then
    rm -f "$TG_DATEI" 2>/dev/null; TG_DATEI=""
    log "kein Telegram-Zugang in .env, Meldung nur im Log: $text"
    return 1
  fi
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 --config "$TG_DATEI" \
    --data-urlencode "chat_id=$chat" --data-urlencode "text=$text" 2>/dev/null || true)
  rm -f "$TG_DATEI" 2>/dev/null; TG_DATEI=""
  case "${code:-0}" in
    2*)
      log "Telegram-Meldung zugestellt (HTTP $code)"
      # Eine Entwarnung darf die Drossel-Uhr NICHT stellen. Sonst wuerde ein
      # echter Alarm, der kurz nach der Entwarnung kommt, bis zu eine Stunde
      # lang unterdrueckt: genau der Fall eines Containers, der nach dem Start
      # gleich wieder stirbt.
      if [ "$sofort" != "sofort" ]; then
        printf '%s' "$jetzt" > "$Z_MELDUNG" 2>/dev/null
        : > "$Z_GEMELDET" 2>/dev/null
      fi
      return 0
      ;;
    *)
      log "ACHTUNG: Telegram-Meldung NICHT zugestellt (HTTP ${code:-keine Antwort}), ich versuche es beim naechsten Lauf wieder"
      return 1
      ;;
  esac
}

zahl_lesen() {
  local n
  n=$(cat "$1" 2>/dev/null || echo 0)
  case "$n" in ''|*[!0-9]*) n=0 ;; esac
  printf '%s' "$n"
}

# Eingriffe im laufenden 24-Stunden-Fenster. Datei: "<startzeit> <anzahl>".
eingriffe_im_fenster() {
  local start anzahl jetzt
  start=0; anzahl=0
  if [ -f "$Z_FENSTER" ]; then read -r start anzahl < "$Z_FENSTER" 2>/dev/null; fi
  case "${start:-}" in ''|*[!0-9]*) start=0 ;; esac
  case "${anzahl:-}" in ''|*[!0-9]*) anzahl=0 ;; esac
  jetzt=$(date +%s)
  if [ "$start" -eq 0 ] || [ $((jetzt - start)) -gt "$FENSTER_S" ]; then
    printf '0'
  else
    printf '%s' "$anzahl"
  fi
}

eingriff_vermerken() {
  local start anzahl jetzt
  start=0; anzahl=0
  if [ -f "$Z_FENSTER" ]; then read -r start anzahl < "$Z_FENSTER" 2>/dev/null; fi
  case "${start:-}" in ''|*[!0-9]*) start=0 ;; esac
  case "${anzahl:-}" in ''|*[!0-9]*) anzahl=0 ;; esac
  jetzt=$(date +%s)
  if [ "$start" -eq 0 ] || [ $((jetzt - start)) -gt "$FENSTER_S" ]; then
    start=$jetzt; anzahl=1
  else
    anzahl=$((anzahl + 1))
  fi
  printf '%s %s' "$start" "$anzahl" > "$Z_FENSTER" 2>/dev/null
}

# Einen unveraenderten, schon gemeldeten Befund nicht jede Stunde wiederholen.
melden_wenn_neu() {
  if [ "$vorher" = "$befund" ] && [ -f "$Z_GEMELDET" ]; then
    log "Befund unveraendert und schon gemeldet, ich melde nicht erneut"
    return 1
  fi
  melden "$1"
}

# =====================  Ablauf  =====================
messen
befund=$(befund_bauen)

if [ -z "$befund" ]; then
  zaehler=$(zahl_lesen "$Z_ZAEHLER")
  if [ "$zaehler" -gt 0 ]; then
    log "wieder in Ordnung, alles laeuft und die Probe antwortet"
    [ -f "$Z_GEMELDET" ] && melden "Rupert: wieder in Ordnung. Alle Container laufen, PostgREST antwortet." sofort
  else
    nur_journal "alles in Ordnung"
  fi
  rm -f "$Z_ZAEHLER" "$Z_BEFUND" "$Z_GEMELDET" 2>/dev/null   # Z_FENSTER bleibt: der Deckel gegen die Absturzschleife ueberlebt die Erholung
  log_kuerzen
  exit 0
fi

# Ohne Gedaechtnis wird nicht gehandelt: wir koennten weder zaehlen noch
# begrenzen noch drosseln. Der Befund geht ins Journal und die Einheit
# scheitert, damit er in "systemctl --failed" sichtbar wird.
if [ "$ZUSTAND_OK" = "0" ]; then
  log "Befund, aber kein beschreibbarer Zustandsordner ($ZUSTAND_DIR, $ZUSTAND_AUSWEICH). Ich greife nicht ein: $befund"
  log_kuerzen
  exit 1
fi

# Der Zaehler zaehlt LAEUFE MIT BEFUND, nicht Wiederholungen desselben Textes.
# Sonst wuerde ein Ausfall, der sich ausbreitet (erst rest, dann rest und kong),
# den Zaehler bei jedem neuen Text zuruecksetzen und nie handeln.
vorher=$(cat "$Z_BEFUND" 2>/dev/null || echo "")
zaehler=$(( $(zahl_lesen "$Z_ZAEHLER") + 1 ))
printf '%s' "$zaehler" > "$Z_ZAEHLER" 2>/dev/null
printf '%s' "$befund" > "$Z_BEFUND" 2>/dev/null

# Bei laufendem Befund nicht jede Runde dieselbe Zeile schreiben.
if [ "$vorher" != "$befund" ] || [ $((zaehler % 10)) -eq 1 ]; then
  log "Befund ($zaehler. Lauf): $befund"
fi

if [ "$zaehler" -lt "$SCHWELLE" ]; then
  nur_journal "noch kein Eingriff, erst ab $SCHWELLE Laeufen mit Befund"
  log_kuerzen
  exit 0
fi

# --- Handeln, aber nur gestoppte Container starten ---
if [ -z "$M_GESTOPPT" ]; then
  log "kein Eingriff moeglich oder sinnvoll, das braucht einen Menschen."
  melden_wenn_neu "Rupert-Waechter: $befund. Ich greife hier nicht ein, bitte schau selbst."
  log_kuerzen
  exit 1
fi

eingriffe=$(eingriffe_im_fenster)
if [ "$eingriffe" -ge "$MAX_EINGRIFFE_24H" ]; then
  log "schon $eingriffe Starts in 24 Stunden, ich hoere auf zu starten und melde nur noch."
  melden_wenn_neu "Rupert-Waechter: $befund. $eingriffe Startversuche in 24 Stunden haben nicht dauerhaft geholfen, ich hoere auf. Bitte schau selbst."
  log_kuerzen
  exit 1
fi

if [ "$NUR_MELDEN" = "1" ]; then
  log "Probemodus: ich wuerde jetzt starten: $M_GESTOPPT"
  melden "Rupert-Waechter (Probemodus): $befund"
  log_kuerzen
  exit 0
fi

eingriff_vermerken
ausgabe=$(docker start $M_GESTOPPT 2>&1)
rc=$?
log "docker start $M_GESTOPPT beendet mit rc=$rc (Start $((eingriffe + 1)) von hoechstens $MAX_EINGRIFFE_24H in 24 Stunden)"
while IFS= read -r z; do [ -n "$z" ] && log "  | $z"; done <<< "$(printf '%s\n' "$ausgabe" | tail -n 5)"

sleep "$NACHPRUEF_S"
messen
nachher=$(befund_bauen)

if [ -z "$nachher" ]; then
  log "behoben: alles laeuft wieder, Probe antwortet"
  # "sofort": auch diese Erfolgsmeldung ist eine gute Nachricht und darf die
  # Drossel-Uhr nicht stellen. Sonst schaltet sie den echten Alarm stumm, der
  # kommt, wenn der Container gleich wieder stirbt. Der Deckel von
  # MAX_EINGRIFFE_24H begrenzt, wie oft das ueberhaupt passieren kann.
  melden "Rupert-Waechter: $befund -> wieder gestartet, laeuft. (Eingriff um $(date -u '+%H:%M UTC'))" sofort
  rm -f "$Z_ZAEHLER" "$Z_BEFUND" "$Z_GEMELDET" 2>/dev/null   # Z_FENSTER bleibt: der Deckel gegen die Absturzschleife ueberlebt die Erholung
  log_kuerzen
  exit 0
fi

log "Eingriff hat nicht geholfen, offen: $nachher"
melden "Rupert-Waechter: $befund. Neustart versucht, es laeuft weiterhin nicht: $nachher"
log_kuerzen
exit 1
