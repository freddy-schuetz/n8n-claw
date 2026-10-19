#!/usr/bin/env bash
# Werkzeugwache fuer den SLT-Agenten: meldet, wenn ein MCP-Server nur noch
# Fehler liefert oder Werkzeugaufrufe leer ankommen.
#
# Anlass (19.10.2026): Nach dem n8n-Update vom 08.10.2026 waren Kalender, Mail,
# SharePoint, Jira, Teams-Bote und Google elf Tage tot. n8n sperrt seit 2.35.4
# den $fromAI-Schluessel "caller", jeder Aufruf endete mit "Invalid parameter
# key". Zugleich kamen Werkzeugaufrufe leer an, weil Sonnet 5 ungefragt dachte
# und n8n fruehere Aufrufe leer zurueckspielte. Gemerkt hat beides niemand: die
# Executions standen auf success, kein Fehler-Workflow loeste aus, und der
# Container-Waechter (claw-wacht.sh) sah laufende Container. Sichtbar war es nur
# in tool_audit_log, wo jeder Werkzeugaufruf mit Status steht. Dort schaut diese
# Wache alle zehn Minuten nach.
#
# Drei Regeln (Durchsicht vom 19.10.2026):
#   1. Ein Server hat seit seinem letzten Erfolg mindestens SCHWELLE Fehler
#      (Fenster 24 Stunden). Faengt den Ausfall eines viel genutzten Servers.
#   2. Ein Server hatte in 24 Stunden keinen einzigen Erfolg und mindestens
#      SCHWELLE_SELTEN Fehler. Faengt selten genutzte Server (Jira hatte im
#      echten Ausfall zwei Aufrufe).
#   3. In den letzten FENSTER_MIN Minuten kamen mindestens SCHWELLE_LEER
#      Werkzeugaufrufe ohne Eingabe an. Das ist das Zeichen, dass das Denken
#      wieder an ist oder n8n Aufrufe wieder leer zurueckspielt.
# Als Fehler zaehlt status = error UND ein ok-Eintrag, dessen Ergebnis ein
# Fachfehler ist ({"error": ...} oder {"fehler": ...}): Skills melden Fehler
# als normales Ergebnis, der MCP Client protokolliert das als ok.
# Je Befund hoechstens eine Meldung in MELDE_ABSTAND_S; kommen bei einem
# gemeldeten Server wieder Erfolge, folgt einmal die Entwarnung.
#
# Was sie NICHT tut: irgendetwas aendern. Sie liest eine Tabelle und schickt
# Nachrichten, sie startet nichts und fasst keinen Container an. Ist die
# Datenbank nicht erreichbar, meldet sie nichts: das ist der Fall des
# Container-Waechters.
#
# Pause wie beim Container-Waechter: touch /root/n8n-claw/ops/PAUSE
#
# Rueckgabe: immer 0, ausser Zustandsordner oder Konfiguration sind kaputt (1).
set -uo pipefail

PROJEKT="${CLAW_PROJEKT:-/root/n8n-claw}"
ZUSTAND_DIR="${CLAW_WERKZEUG_ZUSTAND:-/var/lib/claw-wacht/werkzeuge}"
LOG="${CLAW_WERKZEUG_LOG:-/var/log/claw-werkzeugwacht.log}"
LOG_ZEILEN="${CLAW_LOG_ZEILEN:-5000}"
FENSTER_MIN="${CLAW_WERKZEUG_FENSTER_MIN:-60}"
SCHWELLE="${CLAW_WERKZEUG_SCHWELLE:-3}"
SCHWELLE_SELTEN="${CLAW_WERKZEUG_SCHWELLE_SELTEN:-2}"
SCHWELLE_LEER="${CLAW_WERKZEUG_SCHWELLE_LEER:-3}"
MELDE_ABSTAND_S="${CLAW_WERKZEUG_MELDE_ABSTAND_S:-21600}"
DB_CONTAINER="${CLAW_DB_CONTAINER:-n8n-claw-db}"
PAUSE_DATEI="${CLAW_PAUSE_DATEI:-$PROJEKT/ops/PAUSE}"
TELEGRAM_CHAT_ID_VORGABE="${CLAW_TELEGRAM_CHAT_ID:-}"

TG_DATEI=""
aufraeumen() { if [ -n "$TG_DATEI" ]; then rm -f "$TG_DATEI" 2>/dev/null; fi; : ; }
trap aufraeumen EXIT
trap 'aufraeumen; exit 143' INT TERM

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

# Die Zahlen landen in der Abfrage und in Vergleichen: nur Ziffern zulassen.
for _wert in "$FENSTER_MIN" "$SCHWELLE" "$SCHWELLE_SELTEN" "$SCHWELLE_LEER" "$MELDE_ABSTAND_S" "$LOG_ZEILEN"; do
  case "$_wert" in ''|*[!0-9]*) printf 'ungueltige Zahl in der Konfiguration: %s\n' "$_wert" >&2; exit 1 ;; esac
done

if [ -f "$PAUSE_DATEI" ]; then
  printf '%s Pause: %s liegt da\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$PAUSE_DATEI"
  exit 0
fi

if ! mkdir -p "$ZUSTAND_DIR" 2>/dev/null || ! : > "$ZUSTAND_DIR/.schreibprobe" 2>/dev/null; then
  log "Zustandsordner $ZUSTAND_DIR nicht beschreibbar, ich messe nicht"
  exit 1
fi
rm -f "$ZUSTAND_DIR/.schreibprobe" "$ZUSTAND_DIR"/.telegram.* 2>/dev/null

# Token in eine Datei mit Modus 600, damit er nie in der Prozessliste steht.
telegram_vorbereiten() {
  local datei="$1" token chat
  token=$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' "$PROJEKT/.env" 2>/dev/null | head -1 | tr -d '"'"'"' \t\r')
  chat="$TELEGRAM_CHAT_ID_VORGABE"
  [ -z "$chat" ] && chat=$(sed -n 's/^TELEGRAM_CHAT_ID=//p' "$PROJEKT/.env" 2>/dev/null | head -1 | tr -d '"'"'"' \t\r')
  if [ -z "$token" ] || [ -z "$chat" ]; then return 1; fi
  ( umask 177; printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$token" > "$datei" ) 2>/dev/null || return 1
  printf '%s' "$chat"
}

# Rueckgabe 0 nur, wenn die Nachricht zugestellt wurde. Nur dann wird der
# Zustand fortgeschrieben, sonst versucht es der naechste Lauf noch einmal.
senden() {
  local text="$1" chat code
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
    2*) log "Telegram zugestellt (HTTP $code): $text"; return 0 ;;
    *)  log "Telegram NICHT zugestellt (HTTP ${code:-keine Antwort}), naechster Lauf versucht es wieder: $text"; return 1 ;;
  esac
}

# Ein Zustandsname je Befund: nur Kleinbuchstaben, Ziffern und Bindestrich.
datei_fuer() { printf '%s/%s' "$ZUSTAND_DIR" "$(printf '%s' "$1" | tr -c 'a-z0-9-' '_' | cut -c1-80)"; }

# Gemeldet und noch innerhalb des Abstands? Dann 0 (nicht erneut melden).
gedrosselt() {
  local zuletzt
  zuletzt=$(cat "$1" 2>/dev/null || echo 0)
  case "$zuletzt" in ''|*[!0-9]*) zuletzt=0 ;; esac
  [ $((jetzt - zuletzt)) -lt "$MELDE_ABSTAND_S" ]
}

abfrage() { docker exec "$DB_CONTAINER" psql -U postgres -At -F $'\t' -c "$1" 2>&1; }

# Je Server: Fehler seit dem letzten Erfolg, Erfolge, Fehler (alles 24 Stunden),
# letzter Fehlertext. Servername ist der Pfad nach /mcp/ in der URL.
FEHLER_SQL="(status = 'error' or (status = 'ok' and coalesce(result_summary, '') ~ '^[[:space:]\\[]*\\{[[:space:]]*\"(error|fehler)\"'))"
SQL_SERVER="with t as (
  select regexp_replace(coalesce(server_url, ''), '^.*/mcp/', '') as server, id, created_at,
         $FEHLER_SQL as ist_fehler, status, coalesce(error, result_summary, '') as text
  from tool_audit_log
  where created_at > now() - interval '24 hours' and coalesce(server_url, '') <> '' and status in ('ok', 'error')
), s as (
  select server, max(created_at) filter (where not ist_fehler) as letzter_ok from t group by server
)
select t.server,
  count(*) filter (where t.ist_fehler and t.created_at > coalesce(s.letzter_ok, '-infinity'::timestamptz)),
  count(*) filter (where not t.ist_fehler),
  left(regexp_replace(coalesce((array_agg(t.text order by t.id desc) filter (where t.ist_fehler))[1], ''), '[[:space:]]+', ' ', 'g'), 150)
from t join s using (server) group by t.server order by t.server"
SQL_LEER="select count(*) from tool_audit_log where created_at > now() - interval '$FENSTER_MIN minutes'
  and status = 'rejected' and coalesce(error, '') like 'Aufruf ohne Eingabe%'"

ausgabe=$(abfrage "$SQL_SERVER")
rc=$?
if [ "$rc" -ne 0 ]; then
  log "Datenbank nicht abfragbar (rc=$rc), keine Meldung: $(printf '%s' "$ausgabe" | head -1 | cut -c1-160)"
  log_kuerzen
  exit 0
fi

jetzt=$(date +%s)
while IFS=$'\t' read -r server seit_ok ok letzter; do
  [ -z "${server:-}" ] && continue
  case "${seit_ok:-}" in ''|*[!0-9]*) continue ;; esac
  case "${ok:-}" in ''|*[!0-9]*) continue ;; esac
  zustand=$(datei_fuer "server-$server")
  befund=""
  if [ "$seit_ok" -ge "$SCHWELLE" ]; then
    befund="$server hat seit dem letzten Erfolg $seit_ok Fehler."
  elif [ "$ok" -eq 0 ] && [ "$seit_ok" -ge "$SCHWELLE_SELTEN" ]; then
    befund="$server hatte in 24 Stunden $seit_ok Fehler und keinen Erfolg."
  fi
  if [ -n "$befund" ]; then
    if gedrosselt "$zustand"; then
      printf '%s %s: weiter %s Fehler, schon gemeldet\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$server" "$seit_ok"
      continue
    fi
    if senden "Rupert-Werkzeugwache: $befund Letzter Fehler: ${letzter:-ohne Text}"; then
      printf '%s' "$jetzt" > "$zustand" 2>/dev/null
    fi
  elif [ "$seit_ok" -eq 0 ] && [ "$ok" -gt 0 ] && [ -f "$zustand" ]; then
    if senden "Rupert-Werkzeugwache: $server antwortet wieder (letzter Aufruf erfolgreich)."; then
      rm -f "$zustand" 2>/dev/null
    fi
  fi
done <<< "$ausgabe"

leer=$(abfrage "$SQL_LEER")
rc=$?
if [ "$rc" -eq 0 ] && case "${leer:-}" in ''|*[!0-9]*) false ;; *) true ;; esac; then
  zustand=$(datei_fuer "leere-aufrufe")
  if [ "$leer" -ge "$SCHWELLE_LEER" ] && ! gedrosselt "$zustand"; then
    if senden "Rupert-Werkzeugwache: $leer Werkzeugaufrufe ohne Eingabe in den letzten $FENSTER_MIN Minuten. Vermutlich denkt das Modell wieder (Claude-Knoten: Denken aus?) oder n8n spielt Aufrufe leer zurueck."; then
      printf '%s' "$jetzt" > "$zustand" 2>/dev/null
    fi
  fi
else
  log "Abfrage leere Aufrufe gescheitert (rc=$rc): $(printf '%s' "$leer" | head -1 | cut -c1-120)"
fi

log_kuerzen
exit 0
