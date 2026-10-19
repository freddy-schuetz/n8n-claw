#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Rauchtest fuer Rupert: ruft jeden MCP-Server einmal ECHT auf.

Anlass (Runde 9, 19.10.2026): Nach dem n8n-Update vom 08.10.2026 waren
Kalender, Mail, SharePoint, Jira, Teams-Bote und Google elf Tage tot, ohne dass
es jemand merkte. n8n sperrt seit 2.35.4 den $fromAI-Schluessel "caller", jeder
Aufruf endete still mit "Invalid parameter key", und die Executions standen
trotzdem auf success. initialize und tools/list liefen die ganze Zeit sauber:
der Fehler zeigt sich erst bei einem echten tools/call. Genau den macht dieses
Skript, fuer jeden aktiven Server ein lesender Aufruf.

Nach JEDEM n8n-Update laufen lassen, auf dem Server:

    python3 /root/n8n-claw/ops/rauchtest.py            # nur MCP-Server
    python3 /root/n8n-claw/ops/rauchtest.py --agent    # zusaetzlich eine Agentenfrage

Die Server-Aufrufe sind lesend (Termine heute, eine Mail-Suche, Sites, Projekte,
eine Confluence-Suche, laufende Bots, Wetter). Der Teams-Bote und Google werden
absichtlich so aufgerufen, dass sie vor jedem Schreiben mit einem bestimmten
Fachfehler enden: das belegt, dass der Sub-Workflow startet und die Kennung
ankommt, ohne etwas zu senden. Ausgegeben wird nie ein Inhalt, nur Status und
Laenge.

--agent stellt eine Frage als Pilotkonto (web:freddy, Sitzung web:rauchtest),
die zwei Werkzeuge braucht und nur mit Zahlen beantwortet wird. Sie schreibt
wie jede Anfrage: Verlauf (conversations), Tageslog (memory_daily, daraus macht
die Konsolidierung um 03:00 Gedaechtnis), agent_status, tool_audit_log, und
das Pilotkonto gilt danach als heute begruesst. Nach einem Lauf mit --agent
deshalb die Zeilen der Sitzung web:rauchtest und das Tageslog des Pilotkontos
seit Beginn loeschen, wenn sie nicht ins Gedaechtnis sollen.

Rueckgabe: 0 = alles in Ordnung, 1 = mindestens ein Server oder die
Agentenfrage ist kaputt. Bekannte, vorbestehende Luecken stehen in BEKANNT und
zaehlen nicht als Fehler, werden aber immer angezeigt.
"""
import datetime
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

ENV = '/root/n8n-claw/.env'
AGENT_URL = 'http://127.0.0.1:5678/webhook/agent'
KENNUNG = 'web:freddy'   # Pilotkonto rki.pilot@salzburgerland.com, mit Microsoft verbunden

HEUTE = datetime.date.today().isoformat()
# path -> (Werkzeug, Argumente, Erwartung). Erwartung "ok": muss ohne Fehler
# antworten. Sonst ein Text, den der Fachfehler des Sub-Workflows enthalten
# MUSS: er belegt, dass der Aufruf durch n8n bis in den Code kam UND die
# Kennung dort ankam (der Teams-Bote prueft die Kennung vor "to"; fehlte sie,
# kaeme "Kein Nutzerbezug vorhanden"). Jeder andere Fachfehler ist KAPUTT.
PROBEN = {
    'microsoft-calendar': ('list_events', {'start': HEUTE + 'T00:00:00', 'end': HEUTE + 'T23:59:59', 'limit': '3'}, 'ok'),
    'microsoft-mail': ('search_messages', {'query': 'Rupert', 'limit': '1'}, 'ok'),
    'microsoft-sharepoint': ('list_sites', {}, 'ok'),
    'teams-messages': ('send_teams_message', {'to': '', 'text': ''}, 'ist noetig'),
    'jira': ('list_projects', {}, 'ok'),
    'confluence': ('search_pages', {'query': 'Rupert', 'limit': '1'}, 'ok'),
    'vexa-meetings': ('list_bots', {}, 'ok'),
    'weather-openmeteo': ('get_weather', {'city': 'Salzburg', 'days': '1'}, 'ok'),
    'google-web': ('ga4_fields', {'query': 'sessions'}, 'noch nicht eingerichtet'),
}
# Server, die der Rauchtest auch dann prueft, wenn ihr Registry-Eintrag inaktiv
# ist: der Google-Skill ist absichtlich noch nicht freigeschaltet, sein Server
# laeuft aber und soll beim Freischalten nicht wieder still tot sein.
AUCH_INAKTIV = {'google-web'}
BEKANNT = {
    'placeholder': 'vorbestehend: Registry-Eintrag aktiv, Server-Workflow "MCP: Placeholder" inaktiv (seit 16.09.2026)',
}
KOPF = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}


def env_wert(name):
    try:
        for zeile in open(ENV, encoding='utf-8'):
            if zeile.startswith(name + '='):
                return zeile.strip().split('=', 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ''


def psql(sql):
    r = subprocess.run(['docker', 'exec', 'n8n-claw-db', 'psql', '-U', 'postgres', '-At', '-F', '\t', '-c', sql],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[:300])
    return [z.split('\t') for z in r.stdout.splitlines() if z]


def sse(roh):
    for zeile in reversed(roh.splitlines()):
        zeile = zeile.strip()
        if zeile.startswith('data: '):
            return json.loads(zeile[6:])
    try:
        return json.loads(roh)
    except ValueError:
        return None


def post(url, koerper, kopf, timeout=60):
    r = urllib.request.Request(url, method='POST', headers=kopf, data=json.dumps(koerper).encode('utf-8'))
    with urllib.request.urlopen(r, timeout=timeout) as a:
        return a.headers.get('mcp-session-id'), a.read().decode('utf-8', 'replace')


def mcp_pruefen(url, path):
    """Gibt (status, text) zurueck: OK, KAPUTT oder WARNUNG."""
    kopf = dict(KOPF)
    sitzung = None
    for versuch in range(5):
        try:
            sitzung, _ = post(url, {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
                'protocolVersion': '2024-11-05', 'capabilities': {}, 'clientInfo': {'name': 'rauchtest', 'version': '1'}}}, kopf, 30)
            break
        except urllib.error.HTTPError as e:
            if e.code == 404 and versuch < 4:
                time.sleep(3)
                continue
            return 'KAPUTT', 'initialize HTTP %s' % e.code
        except Exception as e:  # noqa: BLE001
            return 'KAPUTT', 'initialize: %s' % str(e)[:120]
    if sitzung:
        kopf['mcp-session-id'] = sitzung
    post(url, {'jsonrpc': '2.0', 'method': 'notifications/initialized'}, kopf, 30)
    _, roh = post(url, {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list', 'params': {}}, kopf, 30)
    liste = sse(roh) or {}
    werkzeuge = {t.get('name'): t for t in ((liste.get('result') or {}).get('tools') or [])}
    if not werkzeuge:
        return 'KAPUTT', 'tools/list ohne Werkzeuge'
    namen = sorted(werkzeuge)
    doppelt = len(namen) != len(set(namen))
    probe = PROBEN.get(path)
    if not probe:
        # initialize und tools/list liefen waehrend des ganzen Ausfalls sauber:
        # ohne Probeaufruf ist ein Server nicht geprueft.
        return 'KAPUTT', '%d Werkzeuge, aber kein Probeaufruf in PROBEN hinterlegt' % len(werkzeuge)
    name, extra, erwartung = probe
    if name not in werkzeuge:
        return 'KAPUTT', 'Werkzeug %s fehlt (da sind: %s)' % (name, ', '.join(namen)[:200])
    props = ((werkzeuge[name].get('inputSchema') or {}).get('properties') or {})
    # Wie der MCP Client: jedes deklarierte Feld fuellen (der MCP-Trigger
    # verlangt alle), die Kennung setzen, wo das Werkzeug sie anbietet.
    argumente = {k: '' for k in props}
    argumente.update({k: v for k, v in extra.items() if k in props})
    for feld in ('callerid', 'caller'):
        if feld in props:
            argumente[feld] = KENNUNG
    t0 = time.time()
    _, roh = post(url, {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call',
                        'params': {'name': name, 'arguments': argumente}}, kopf, 90)
    dauer = time.time() - t0
    antwort = sse(roh) or {}
    if antwort.get('error'):
        return 'KAPUTT', '%s: JSON-RPC-Fehler %s' % (name, json.dumps(antwort['error'])[:160])
    ergebnis = antwort.get('result') or {}
    text = ''
    for teil in ergebnis.get('content') or []:
        if teil.get('type') == 'text':
            text += teil.get('text', '')
    if 'Invalid parameter key' in text or 'There was an error' in text:
        return 'KAPUTT', '%s: n8n lehnt den Aufruf ab: %s' % (name, text[:160])
    hinweis = ' (Achtung: doppelte Werkzeugnamen)' if doppelt else ''
    fachfehler = ergebnis.get('isError') or '"error":' in text[:40] or '"fehler":' in text[:40]
    if erwartung != 'ok':
        if erwartung in text:
            return 'OK', '%s: Sub-Workflow lief, Kennung kam an, erwarteter Fachfehler nach %.1f s%s' % (name, dauer, hinweis)
        return 'KAPUTT', '%s: erwartet war ein Fachfehler mit "%s", kam: %s' % (name, erwartung, text[:140])
    if fachfehler:
        return 'KAPUTT', '%s: Fehler nach %.1f s: %s' % (name, dauer, text[:160])
    return 'OK', '%s: Antwort %d Zeichen nach %.1f s, %d Werkzeuge%s' % (name, len(text), dauer, len(werkzeuge), hinweis)


def agent_pruefen():
    geheim = env_wert('WEBHOOK_SECRET')
    if not geheim:
        return 'KAPUTT', 'WEBHOOK_SECRET fehlt in der .env'
    beginn = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M:%S+00')
    # Zwei Werkzeuge in einer Anfrage: erst dann zeigt sich, ob n8n fruehere
    # Aufrufe richtig zurueckspielt (Issue #40360). Die Antwort traegt nur Zahlen,
    # keine Inhalte, weil sie im Verlauf und im Tageslog des Pilotkontos landet.
    koerper = {'message': 'Rauchtest: Wie viele Termine habe ich heute, und wie viele Treffer liefert eine '
                          'Confluence-Suche nach Wellpass? Antworte nur mit zwei Zahlen.',
               'user_id': KENNUNG, 'session_id': 'web:rauchtest', 'source': 'web'}
    try:
        _, roh = post(AGENT_URL, koerper, {'Content-Type': 'application/json', 'X-API-Key': geheim}, 300)
    except urllib.error.HTTPError as e:
        return 'KAPUTT', 'Agent-Webhook HTTP %s' % e.code
    except Exception as e:  # noqa: BLE001
        return 'KAPUTT', 'Agent-Webhook: %s' % str(e)[:120]
    try:
        d = json.loads(roh)
    except ValueError:
        return 'KAPUTT', 'Agent antwortet ohne JSON: %s' % roh[:120]
    if isinstance(d, list):
        d = d[0] if d else {}
    antwort = str(d.get('response') or d.get('output') or '')
    if not antwort.strip():
        return 'KAPUTT', 'Agent antwortet leer'
    if d.get('fallback') or (d.get('metadata') or {}).get('fallback'):
        return 'KAPUTT', 'Agent lieferte den Ersatztext (Abbruch im Lauf)'
    time.sleep(3)
    # Fehler- und Ergebnistexte tragen Zeilenumbrueche: zusammenziehen, sonst
    # zerfallen die Zeilen beim Lesen.
    zeilen = psql("select regexp_replace(coalesce(server_url,''), '^.*/mcp/', ''), status, "
                  "coalesce(args->>'callerid', args->>'caller', ''), "
                  "regexp_replace(coalesce(error, ''), '[[:space:]]+', ' ', 'g'), "
                  "regexp_replace(left(coalesce(result_summary, ''), 40), '[[:space:]]+', ' ', 'g') "
                  "from tool_audit_log where session_id = 'web:rauchtest' and created_at >= '%s' order by id" % beginn)
    leer = [z for z in zeilen if 'ohne Eingabe' in z[3]]
    if leer:
        return 'KAPUTT', '%d Werkzeugaufruf(e) ohne Eingabe: n8n spielt Aufrufe wieder leer zurueck (Denken an?)' % len(leer)
    kalender = [z for z in zeilen if z[0] == 'microsoft-calendar']
    confluence = [z for z in zeilen if z[0] == 'confluence']
    if not kalender or not confluence:
        return 'KAPUTT', 'Agent rief nicht beide Werkzeuge auf (Kalender %d, Confluence %d)' % (len(kalender), len(confluence))
    fehl = [z for z in kalender + confluence if z[1] != 'ok' or z[4].lstrip('[ ').startswith('{"error"')]
    if fehl:
        return 'KAPUTT', 'Werkzeugfehler: %s' % '; '.join('%s %s %s' % (z[0], z[1], (z[3] or z[4])[:60]) for z in fehl)[:240]
    if not any(z[2] == KENNUNG for z in kalender):
        return 'KAPUTT', 'Kalenderaufruf ohne die Kennung %s' % KENNUNG
    return 'OK', 'Agent antwortete (%d Zeichen), Kalender und Confluence ok, keine leeren Aufrufe, Kennung vom Client' % len(antwort)


def main():
    mit_agent = '--agent' in sys.argv
    print('Rauchtest %s' % datetime.datetime.now().strftime('%d.%m.%Y %H:%M'))
    try:
        v = subprocess.run(['docker', 'exec', 'n8n-claw', 'n8n', '--version'], capture_output=True, text=True).stdout.strip()
    except OSError:
        v = '?'
    print('n8n %s\n' % v)
    zeilen = psql('select path, mcp_url, active from mcp_registry order by id')
    kaputt = 0
    for path, url, aktiv in zeilen:
        if aktiv != 't' and path not in AUCH_INAKTIV:
            continue
        try:
            status, text = mcp_pruefen(url, path)
        except Exception as e:  # noqa: BLE001
            status, text = 'KAPUTT', 'Ausnahme: %s' % str(e)[:160]
        if status == 'KAPUTT' and path in BEKANNT:
            status, text = 'BEKANNT', BEKANNT[path]
        if status == 'KAPUTT':
            kaputt += 1
        print('%-8s %-22s %s' % (status, path, text))
    if mit_agent:
        status, text = agent_pruefen()
        if status == 'KAPUTT':
            kaputt += 1
        print('%-8s %-22s %s' % (status, 'agent', text))
    print('\n%s' % ('ALLES IN ORDNUNG' if not kaputt else '%d KAPUTT' % kaputt))
    return 1 if kaputt else 0


if __name__ == '__main__':
    sys.exit(main())
