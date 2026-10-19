# ops: Waechter fuer den Docker-Stapel

## Warum das hier liegt

Am 25.09.2026 wurde der SLT-Server um 04:00 hart neu gestartet. Beim Hochlaufen
um 04:49 kamen zwoelf von dreizehn Containern zurueck, `n8n-claw-rest`
(PostgREST) nicht: Docker scheiterte beim Wiederherstellen des Containers
("layer not mounted"), setzte Exit 255 und gab auf. `restart: unless-stopped`
hilft in diesem Fall nicht, weil Docker den Neustart selbst als gescheitert
abhakt.

Die Folge war unsichtbar und total: Kong konnte den Namen `rest` nicht mehr
aufloesen und antwortete auf jeden Aufruf von `/rest/v1/...` mit 503. Weil jede
Agenten-Ausfuehrung Seele, Konfiguration und Profil ueber PostgREST laedt, starb
sie sofort. Acht Stunden, 530 gescheiterte Ausfuehrungen. Aufgefallen ist es
erst, als Florian Schumacher am Vormittag fragte, was mit Rupert los sei.

Zweite Lehre aus demselben Vorfall: der Reminder Runner und der
MS-Token-Refresh sind 526 mal gescheitert, ohne dass jemand eine Nachricht
bekam, weil in diesen Workflows kein Fehler-Workflow hinterlegt ist. Der
Waechter deckt den Fall "Container weg" ab. Der Fall "Container laeuft, aber der
Workflow scheitert" gehoert in die Workflows selbst und ist noch offen.

## Was der Waechter tut

`claw-wacht.sh` laeuft alle zwei Minuten per systemd-Timer und misst drei Dinge:

1. **Compose-Container:** `docker ps -a` mit dem Projekt-Label
   (`com.docker.compose.project=n8n-claw`). Gemessen wird der Zustand je
   Container, nicht ueber `docker compose ps`: so haengt die Messung an einem
   einzigen Aufruf, dessen Rueckgabewert geprueft wird.
2. **Container ausserhalb von Compose:** `slt-frontend` (Webchat) und
   `teams-bridge` sind eigene `docker run`-Container. Ein Waechter, der nur
   Compose kennt, wuerde genau den Webchat und die Teams-Bruecke uebersehen.
3. **PostgREST:** antwortet `http://127.0.0.1:3000/` mit 200? Diese Probe wird
   immer gemessen, nie von einem anderen Befund verdeckt.

Zusaetzlich vergleicht er die Dienste aus `docker compose config --services` mit
den vorhandenen Containern. Ein Dienst, dessen Container ganz verschwunden ist
(gescheitertes Recreate, `docker rm`, prune), waere sonst unsichtbar.

### Die Regeln, die ihn harmlos halten

- **Er startet nur, was existiert und gestoppt ist, mit `docker start`.** Kein
  `compose up` (das kann Nachbarcontainer neu bauen, sobald die Compose-Datei
  oder die `.env` von dem abweicht, womit sie einst gestartet wurden), kein
  `restart`, kein `down`, kein Image-Pull.
- **Einen laufenden Container fasst er nie an.** Auch nicht, wenn die Probe
  fehlschlaegt. Dann meldet er und laesst den Eingriff einem Menschen.
- **Status `restarting` laesst er in Ruhe.** Da arbeitet Docker selbst an der
  Sache, da pfuscht der Waechter nicht hinein.
- **Zwei Laeufe Geduld:** gehandelt wird erst, wenn zwei Laeufe hintereinander
  einen Befund sehen, also rund vier Minuten nach dem Ausfall. Gezaehlt werden
  Laeufe mit Befund, nicht Wiederholungen desselben Textes: ein Ausfall, der
  sich ausbreitet, erreicht die Schwelle sonst nie.
- **Deckel gegen die Absturzschleife:** hoechstens fuenf Starts in 24 Stunden.
  Dieser Zaehler ueberlebt eine erfolgreiche Erholung ausdruecklich, sonst
  wuerde ein Container, der nach jedem Start wieder stirbt, ewig neu gestartet
  und das Einzige, was ankommt, waere "laeuft wieder".
- **Kann er die Lage nicht messen, tut er nichts.** Ein Fehler der Abfrage ist
  nicht dasselbe wie "alles ist tot".
- **Ohne beschreibbaren Zustandsordner greift er nicht ein**, sondern meldet ins
  Journal und endet mit Rueckgabe 1. Ohne Gedaechtnis koennte er weder zaehlen
  noch begrenzen noch drosseln.
- **Pausenbremse:** `touch /root/n8n-claw/ops/PAUSE` und er haelt sich komplett
  heraus, solange die Datei liegt. Wer von Hand an den Containern arbeitet, legt
  sie an und loescht sie danach. Alternativ `systemctl stop claw-wacht.timer`.

### Meldungen

Telegram an die Kennung aus `TELEGRAM_CHAT_ID` in der `.env`, hoechstens einmal
pro Stunde. Der Token steht nie in der Kommandozeile (also nie in der
`ps`-Ausgabe): `curl` liest ihn per `--config` aus einer Datei mit Modus 600, die
auch bei einem Abbruch aufgeraeumt wird.

- Als zugestellt gilt nur eine Antwort mit HTTP 2xx. Eine nicht zugestellte
  Meldung (abgelaufener Token, kein Netz) schaltet die naechste Stunde **nicht**
  stumm, sondern wird beim naechsten Lauf erneut versucht.
- Ein unveraenderter Befund, der schon gemeldet wurde, wird nicht stuendlich
  wiederholt.
- Die Entwarnung kommt sofort, ohne Drosselung, und stellt die Drossel-Uhr
  nicht: ein echter Alarm direkt nach einer Entwarnung kommt an.
- Fehlt ein Telegram-Zugang in der `.env`, laeuft der Waechter weiter und
  schreibt nur ins Log.

Log: `/var/log/claw-wacht.log`, gekuerzt auf die letzten 10000 Zeilen. Auf einem
gesunden Server entsteht die Datei gar nicht, die Laeufe stehen dann nur im
Journal (`journalctl -u claw-wacht.service`).

## Einbau auf dem Server

```bash
install -d /root/n8n-claw/ops
install -m 755 claw-wacht.sh /root/n8n-claw/ops/claw-wacht.sh
install -m 644 README.md     /root/n8n-claw/ops/README.md
install -m 644 claw-wacht.service /etc/systemd/system/claw-wacht.service
install -m 644 claw-wacht.timer   /etc/systemd/system/claw-wacht.timer
systemctl daemon-reload
systemctl enable --now claw-wacht.timer
```

`StateDirectory=claw-wacht` in der Einheit legt `/var/lib/claw-wacht` an.

Pruefen, **ohne** den Produktivzustand anzufassen (eigener Zustandsordner, eigenes
Log, Schwelle 1, Probemodus greift nicht ein):

```bash
systemctl list-timers claw-wacht.timer
CLAW_ZUSTAND_DIR=/tmp/wacht-probe CLAW_LOG=/tmp/wacht-probe.log \
  CLAW_SCHWELLE=1 CLAW_PROBE_ERZWINGEN=fehler CLAW_NUR_MELDEN=1 \
  /root/n8n-claw/ops/claw-wacht.sh
rm -rf /tmp/wacht-probe /tmp/wacht-probe.log
journalctl -u claw-wacht.service --since "-10 min"
```

Ein Hand-Lauf ohne eigenen `CLAW_ZUSTAND_DIR` wuerde Zaehler und Drosselung des
Timers verschieben und eine echte Meldung ausloesen.

## Schalter (Umgebungsvariablen)

| Variable | Vorgabe | Zweck |
|---|---|---|
| `CLAW_PROJEKT` | `/root/n8n-claw` | Projektordner mit `docker-compose.yml` und `.env` |
| `CLAW_PROJEKTNAME` | Ordnername | Compose-Projektname fuer das Container-Label |
| `CLAW_EINZELCONTAINER` | `slt-frontend teams-bridge` | Container ausserhalb von Compose; leerer Wert schaltet sie ab |
| `CLAW_IGNORIEREN` | leer | Compose-Dienste, die absichtlich keinen Container haben |
| `CLAW_PROBE_URL` | `http://127.0.0.1:3000/` | Probe auf PostgREST |
| `CLAW_SCHWELLE` | `2` | Laeufe mit Befund, bevor eingegriffen wird |
| `CLAW_MAX_EINGRIFFE_24H` | `5` | Deckel gegen die Absturzschleife |
| `CLAW_NACHPRUEF_S` | `30` | Wartezeit, bis nach dem Start nachgemessen wird |
| `CLAW_MELDE_ABSTAND_S` | `3600` | Drosselung der Telegram-Meldungen |
| `CLAW_NUR_MELDEN` | `0` | `1` = nichts starten, nur melden (Probemodus) |
| `CLAW_PROBE_ERZWINGEN` | leer | `fehler` = Probe gilt als fehlgeschlagen (Test) |
| `CLAW_PAUSE_DATEI` | `<Projekt>/ops/PAUSE` | liegt sie da, tut der Waechter nichts |
| `CLAW_ZUSTAND_DIR` | `/var/lib/claw-wacht` | Zaehler und Zeitstempel |
| `CLAW_ZUSTAND_AUSWEICH` | `/run/claw-wacht` | Ausweichort, wenn der erste nicht beschreibbar ist |
| `CLAW_LOG` | `/var/log/claw-wacht.log` | Log |

## Tests

`ops/claw-wacht.test.sh` prueft das Verhalten gegen erfundene `docker`- und
`curl`-Befehle, ohne echten Server:

```bash
bash ops/claw-wacht.test.sh
```

Die Faelle mit `[P]` im Namen stellen je einen Befund der adversarialen Pruefung
vom 25.09.2026 nach (vier Pruefer mit den Linsen Shell, Docker, systemd und
Betrieb, 24 Befunde, jeder einzeln auf Widerlegung geprueft), damit derselbe
Fehler nicht zurueckkommt. Die wichtigsten davon:

- Ein Fehler der Zustandsabfrage darf nicht als "alles ist tot" gelesen werden.
- Der Zaehler darf nicht am Wortlaut des Befunds haengen.
- `restarting` ist Dockers eigene Schleife, da nicht hineingreifen.
- Ein fehlender Einzelcontainer darf die PostgREST-Probe nicht verdecken.
- Eine nicht zugestellte Telegram-Meldung darf nicht als zugestellt gelten.
- Die Entwarnung darf keinen folgenden echten Alarm stumm schalten.
- Ein flatternder Container muss den Deckel erreichen und einen Menschen rufen.

---

# Werkzeugwache, Rauchtest und MCP-Sperre (Runde 9, 19.10.2026)

## Warum

Nach dem n8n-Update vom 08.10.2026 (2.34.5 auf 2.42.3) waren Kalender, Mail,
SharePoint, Jira, Teams-Bote und Google elf Tage tot. n8n sperrt seit 2.35.4
den `$fromAI`-Schluessel `caller` (Sicherheitskorrektur GHSA-9x83-43r8-5hwc),
jeder Aufruf endete mit "Invalid parameter key". Zugleich kamen
Werkzeugaufrufe leer an: Sonnet 5 denkt seit n8n 2.37 ungefragt, und n8n
spielt danach fruehere Aufrufe leer zurueck (Issue #40360). Niemand bekam eine
Meldung: die Executions standen auf success, kein Fehler-Workflow loeste aus,
und der Container-Waechter sah laufende Container. Sichtbar war es nur in
`tool_audit_log`.

## MCP-Endpunkte nur von innen

Die MCP-Trigger der Skills haben keine eigene Anmeldung, und die Kennung der
fragenden Person ist dort ein freies Argument. Bis zum 19.10.2026 reichte nginx
`/mcp/` fuer jeden aus dem Internet an n8n weiter. Seitdem steht in
`/etc/nginx/sites-available/n8n-claw` vor `location /` ein Block
`location ~ ^/mcp(-test)?/`, der nur den Server selbst (127.0.0.1, ::1, die
eigene IPv4 und IPv6) und die Docker-Netze (172.16.0.0/12) zulaesst. Rupert ruft
seine Skills ueber die oeffentliche Adresse aus dem Docker-Netz auf und ist
davon nicht betroffen. Eingebaut mit `projects/slt/setup/mcp-sperre.sh`
(Sicherung, `nginx -t`, Probe von innen, Ruecknahme bei Fehler). Dauerhaft
gehoert an jeden MCP-Trigger zusaetzlich ein Token (`mcp_registry.auth_type`,
`auth_token`; der MCP Client liest beides schon).

## Modelle

`thinking=false` am Claude-Knoten gilt nur fuer `claude-sonnet-5`. Sonnet 5.5,
Opus 5.5, Haiku 5.5 und Fable lehnen `thinking: disabled` mit 400 ab, und den
Ersatz `between_tools` kennt der Knoten bis n8n 2.44.3 nicht. Diese Modelle
erst einsetzen, wenn n8n den Fix fuer Issue #40360 (PR #41241) in einer Version
ausliefert, und vorher in einer Wegwerf-Kopie testen. `tests/fromai-sperrliste.test.js`
blockiert beides.

## claw-werkzeugwacht.sh

Laeuft alle zehn Minuten (`claw-werkzeugwacht.timer`), liest nur, startet
nichts. Drei Regeln:

1. Ein Server hat seit seinem letzten Erfolg mindestens drei Fehler (Fenster
   24 Stunden).
2. Ein Server hatte in 24 Stunden keinen Erfolg und mindestens zwei Fehler
   (selten genutzte Server; Jira hatte im echten Ausfall zwei Aufrufe).
3. In der letzten Stunde kamen mindestens drei Werkzeugaufrufe ohne Eingabe an
   (das Denken ist wieder an oder n8n spielt Aufrufe leer zurueck).

Als Fehler zaehlen `status = error` und `ok`-Eintraege, deren Ergebnis ein
Fachfehler ist (`{"error": ...}`). Je Befund hoechstens eine Telegram-Meldung in
sechs Stunden, nach einer Erholung einmal die Entwarnung. Gegen die echte
Datenbank geprueft: am 12.10.2026 um 17:30 haette sie fuer den Kalender
gemeldet, am 14.10.2026 um 11:00 fuer Mail, SharePoint und Jira. Teams-Bote und
Google hatten keine Aufrufe; das deckt nur der Rauchtest ab.

| Variable | Vorgabe | Zweck |
|---|---|---|
| `CLAW_WERKZEUG_SCHWELLE` | `3` | Fehler seit dem letzten Erfolg |
| `CLAW_WERKZEUG_SCHWELLE_SELTEN` | `2` | Fehler ohne Erfolg in 24 Stunden |
| `CLAW_WERKZEUG_SCHWELLE_LEER` | `3` | Aufrufe ohne Eingabe in `FENSTER_MIN` |
| `CLAW_WERKZEUG_FENSTER_MIN` | `60` | Fenster fuer Regel 3 |
| `CLAW_WERKZEUG_MELDE_ABSTAND_S` | `21600` | Drosselung je Befund |
| `CLAW_WERKZEUG_ZUSTAND` | `/var/lib/claw-wacht/werkzeuge` | Zeitstempel je gemeldetem Befund |
| `CLAW_WERKZEUG_LOG` | `/var/log/claw-werkzeugwacht.log` | Log |

Tests: `bash ops/claw-werkzeugwacht.test.sh` (erfundene `docker`- und
`curl`-Befehle, kein Server).

## rauchtest.py: nach JEDEM n8n-Update

```bash
python3 /root/n8n-claw/ops/rauchtest.py            # jeder aktive MCP-Server einmal echt
python3 /root/n8n-claw/ops/rauchtest.py --agent    # dazu eine Frage an den Agenten
```

`initialize` und `tools/list` liefen waehrend des ganzen Ausfalls sauber, der
Fehler zeigt sich erst bei einem echten `tools/call`. Der Rauchtest macht je
Server einen lesenden Aufruf mit dem Pilotkonto (`web:freddy`); Teams-Bote und
Google enden absichtlich mit einem bestimmten Fachfehler vor jedem Schreiben.
Ein Server ohne hinterlegten Probeaufruf gilt als nicht geprueft (KAPUTT).
`--agent` stellt eine Frage, die Kalender und Confluence braucht, und prueft,
dass beide ok sind, kein Aufruf leer ankam und die Kennung vom Client kam. Sie
schreibt wie jede Anfrage in Verlauf, Tageslog und `tool_audit_log` (siehe
Kopf von `rauchtest.py`). Rueckgabe 1, sobald etwas kaputt ist.

Gegen den Stand vor dem Fix gelaufen (18.10.2026, 23:13): er meldete genau die
sechs toten Server und liess Confluence, Vexa und Wetter gruen.

## Einbau (zusaetzlich zum Container-Waechter)

```bash
install -m 755 claw-werkzeugwacht.sh /root/n8n-claw/ops/claw-werkzeugwacht.sh
install -m 755 rauchtest.py          /root/n8n-claw/ops/rauchtest.py
install -m 644 README.md             /root/n8n-claw/ops/README.md
install -m 644 claw-werkzeugwacht.service /etc/systemd/system/claw-werkzeugwacht.service
install -m 644 claw-werkzeugwacht.timer   /etc/systemd/system/claw-werkzeugwacht.timer
systemctl daemon-reload
systemctl enable --now claw-werkzeugwacht.timer
```

Hinweis: `/root/n8n-claw/ops` ist auf dem Server nicht versioniert (der
Server-Checkout steht noch auf `34848f4`). Ein spaeteres `git pull` dort
scheitert an den unversionierten Dateien, bis der Checkout auf den Zweigstand
gebracht ist.

## Commit-Sperre

`.githooks/pre-commit` fuehrt `tests/fromai-sperrliste.test.js` auf dem
gestagten Stand aus (gesperrte `$fromAI`-Schluessel in jeder Schreibweise,
Denk-Einstellung passend zum Modell). Einschalten einmal je Klon:
`git config core.hooksPath .githooks`.

# Alte Schwachstellen (Runde 10, 19.10.2026)

Nur Workflow-Code, keine neuen Dienste. Tests unter `tests/` (konsolidierung,
microsoft-erneuerung, heartbeat-offene-vorhaben, agent-history-geplant,
teams-adapter-vorbereiten).

## Naechtliche Zusammenfassung (Memory Consolidation)

- Der Zeiger (`heartbeat_config`, `memory_consolidation`, `config.last_id`)
  rueckt nur ueber Tage, die gespeichert sind oder schon eine Zusammenfassung
  haben. Ein gescheiterter Tag steht in `config.fehlversuche` und wird in der
  naechsten Nacht erneut versucht; nach drei Naechten wird er uebersprungen und
  in `config.uebersprungen` vermerkt.
- Einen Tag neu erzeugen: seinen Eintrag (`category = 'consolidated'`,
  `metadata->>'date'`) loeschen und `last_id` vor den Tag setzen. Vorhandene
  Tage werden uebersprungen, es entstehen keine Dubletten.
- Das Protokoll traegt die Namen aus `user_profiles`, gegliedert nach Personen.

## Microsoft-Zugaenge

`reconnect_required` setzen der Hintergrundlauf und die Skills nur noch bei
`invalid_grant` oder `interaction_required`. Netz, 5xx, 429, `invalid_client`
und Speicherfehler lassen den Zugang verbunden, der Grund steht in
`user_oauth_tokens.status_detail`, der naechste Lauf versucht es erneut.

## Offene Vorhaben (Heartbeat)

Die Nachfrage geht an `memory_long.owner_user_id`, einmal je Vorhaben
(`metadata.nachgefragt_am`), werktags 8 bis 17 Uhr Wiener Zeit. Anders
einstellen: `heartbeat_config` `open_loop_check`, `config.zeitfenster`
(`zeitzone`, `von`, `bis`, `werktage`).
