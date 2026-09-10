// Runde 6 (10.09.2026): der Sub-Workflow "Zustellung" bringt Erinnerungen,
// Ergebnisse geplanter Laeufe und Heartbeat-Meldungen zur Person: Telegram
// (Nummer), Teams (Bruecke /send plus Zeile in conversations) oder nur Verlauf.
// Der ECHTE Code des Knotens "Zustellen" laeuft mit gefaelschten HTTP-Aufrufen.
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const wf = JSON.parse(fs.readFileSync(path.join(REPO, 'workflows/zustellung.json'), 'utf8'));
const CODE = wf.nodes.find(n => n.name === 'Zustellen').parameters.jsCode
  .replace(/\{\{SUPABASE_URL\}\}/g, 'http://stub.local')
  .replace(/\{\{SUPABASE_SERVICE_KEY\}\}/g, 'stub-key')
  .replace(/\{\{BRIDGE_URL\}\}/g, 'http://bridge.local')
  .replace(/\{\{BRIDGE_SECRET\}\}/g, 'GEHEIM');

const MAP = { 'web:florian': '1d94fefe-oid-florian', 'web:sophie': 'oid-sophie' };

async function run(items, opts) {
  opts = opts || {};
  const sink = { sends: [], conv: [], mapLookups: [] };
  const helpers = {
    async httpRequest(o) {
      const url = String(o.url || '');
      if (url.includes('user_identity_map')) {
        const key = decodeURIComponent(url.split('legacy_key=eq.')[1].split('&')[0]);
        sink.mapLookups.push(key);
        if (opts.mapFehler) throw new Error('DB weg');
        return MAP[key] ? [{ entra_oid: MAP[key] }] : [];
      }
      if (url.endsWith('/send')) {
        const body = JSON.parse(o.body);
        sink.sends.push(body);
        if (opts.sendStatus === 403) { const e = new Error('403'); e.response = { body: { ok: false, grund: 'nicht_installiert' } }; throw e; }
        if (opts.sendStatus === 502) { const e = new Error('502 Bad Gateway'); throw e; }
        return { ok: true, conversationId: 'a:CONV-' + body.aadObjectId.slice(0, 4) };
      }
      if (url.includes('/conversations')) { sink.conv.push(JSON.parse(o.body)); if (opts.convFehler) throw new Error('conv kaputt'); return ''; }
      throw new Error('unerwarteter Aufruf ' + url);
    }
  };
  const $input = { all: () => items.map(json => ({ json })) };
  const fn = new AsyncFunction('$input', 'helpers', CODE + '\n//# sourceURL=zustellen.js');
  let out, threw = null;
  try { out = await fn($input, helpers); } catch (e) { threw = e; }
  return { out: (out || []).map(i => i.json), threw, sink };
}

let n = 0, f = 0;
function pruefe(name, ok, info) { n++; if (!ok) f++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + JSON.stringify(info).slice(0, 400))); }

(async () => {
  console.log('--- Telegram ---');
  let r = await run([{ user_id: 'telegram:1810565648', chat_id: '1810565648', text: 'Hallo' }]);
  pruefe('Nummer als chat_id -> weg telegram, nichts gesendet, kein Verlauf', r.out[0].weg === 'telegram' && r.out[0].chat_id === '1810565648' && r.sink.sends.length === 0 && r.sink.conv.length === 0, r);
  r = await run([{ user_id: 'telegram:42', chat_id: '', message: 'Hallo' }]);
  pruefe('telegram:-Kennung ohne chat_id -> Nummer aus der Kennung', r.out[0].weg === 'telegram' && r.out[0].chat_id === '42', r.out[0]);
  r = await run([{ user_id: 'telegram:42', chat_id: '42', text: 'x', kopf: '⏰ ' }]);
  pruefe('kopf wird vorangestellt', r.out[0].text === '⏰ x', r.out[0]);

  console.log('--- Teams ---');
  r = await run([{ user_id: 'web:florian', chat_id: 'teams:a:SESS', text: 'Erinnerung: Billing-Nummer', art: 'erinnerung' }]);
  pruefe('web:florian -> Zuordnung gelesen, /send mit Entra-Kennung', r.sink.mapLookups[0] === 'web:florian' && r.sink.sends.length === 1 && r.sink.sends[0].aadObjectId === MAP['web:florian'] && r.sink.sends[0].text === 'Erinnerung: Billing-Nummer', r.sink);
  pruefe('weg teams, zugestellt', r.out[0].weg === 'teams' && r.out[0].zugestellt === true && r.out[0].grund === null, r.out[0]);
  pruefe('Zeile in conversations in der Teams-Sitzung der Bruecke', r.sink.conv.length === 1 && r.sink.conv[0].session_id === 'teams:a:CONV-1d94' && r.sink.conv[0].user_id === 'web:florian' && r.sink.conv[0].role === 'assistant' && r.sink.conv[0].content === 'Erinnerung: Billing-Nummer' && r.sink.conv[0].metadata.zustellung === 'teams' && r.sink.conv[0].metadata.art === 'erinnerung', r.sink.conv);
  r = await run([{ user_id: 'entra:abc-123', chat_id: '', text: 'Hi' }]);
  pruefe('entra:-Kennung braucht keine Zuordnung', r.sink.mapLookups.length === 0 && r.sink.sends[0].aadObjectId === 'abc-123' && r.out[0].weg === 'teams', r.sink);
  r = await run([{ user_id: 'web:florian', chat_id: 'web:florian', text: 'Fertig', im_verlauf: true }]);
  pruefe('im_verlauf=true: Teams ja, keine zweite Zeile im Verlauf', r.out[0].weg === 'teams' && r.sink.sends.length === 1 && r.sink.conv.length === 0, r.sink);
  const lang = Array.from({ length: 60 }, (_, i) => 'Absatz ' + i + ' ' + 'x'.repeat(60)).join('\n\n');
  r = await run([{ user_id: 'web:florian', chat_id: 'web:florian', text: lang, im_verlauf: true }]);
  pruefe('langer Text wird in Stuecke unter 2000 Zeichen geteilt, nichts geht verloren',
    r.sink.sends.length >= 2 && r.sink.sends.every(s => s.text.length <= 1900) && r.sink.sends.map(s => s.text).join('\n\n').replace(/\s+/g, '') === lang.replace(/\s+/g, ''), r.sink.sends.map(s => s.text.length));
  pruefe('Stuecke brechen an Absatzgrenzen', r.sink.sends.every(s => /^Absatz \d+ /.test(s.text)), r.sink.sends.map(s => s.text.slice(0, 12)));

  console.log('--- Verlauf als sicherer Ausgang ---');
  r = await run([{ user_id: 'web:unbekannt', chat_id: 'web:unbekannt', text: 'Hallo' }]);
  pruefe('keine Zuordnung -> weg verlauf, Grund benannt, Zeile in der Sitzung', r.out[0].weg === 'verlauf' && /keine Teams-Zuordnung/.test(r.out[0].grund) && r.sink.sends.length === 0 && r.sink.conv.length === 1 && r.sink.conv[0].session_id === 'web:unbekannt' && r.out[0].im_verlauf === true, r);
  r = await run([{ user_id: 'web:florian', chat_id: 'teams:a:SESS', text: 'Hallo' }], { sendStatus: 403 });
  pruefe('403 nicht_installiert -> verlauf in der uebergebenen Sitzung, Grund klar', r.out[0].weg === 'verlauf' && r.out[0].grund === 'Rupert in Teams nie geoeffnet' && r.sink.conv[0].session_id === 'teams:a:SESS' && r.out[0].zugestellt === false, r.out[0]);
  r = await run([{ user_id: 'web:florian', chat_id: 'teams:a:SESS', text: 'Hallo' }], { sendStatus: 502 });
  pruefe('Brueckenfehler -> verlauf, nichts geworfen', r.threw === null && r.out[0].weg === 'verlauf' && /502/.test(r.out[0].grund) && r.sink.conv.length === 1, r);
  r = await run([{ user_id: 'web:florian', chat_id: 'teams:a:SESS', text: 'Hallo' }], { mapFehler: true });
  pruefe('Zuordnung nicht lesbar -> verlauf mit Grund, nichts geworfen', r.threw === null && r.out[0].weg === 'verlauf' && /Zuordnung nicht lesbar/.test(r.out[0].grund), r.out[0]);
  r = await run([{ user_id: 'web:florian', chat_id: 'teams:a:SESS', text: 'Hallo' }], { sendStatus: 403, convFehler: true });
  pruefe('auch der Verlauf kaputt -> nichts geworfen, Fehler im Datensatz', r.threw === null && r.out[0].im_verlauf === false && /conv kaputt/.test(r.out[0].verlauf_fehler), r.out[0]);
  r = await run([{ user_id: 'web:florian', chat_id: '', session_id: '', text: 'Hallo' }], { sendStatus: 403 });
  pruefe('ohne Sitzung faellt der Verlauf auf die Kennung zurueck', r.sink.conv[0].session_id === 'web:florian', r.sink.conv);

  console.log('--- Eingabeformen ---');
  r = await run([{ user_id: 'web:sophie', chat_id: 'web:sophie', checkerMessage: 'Neu im Postfach', im_verlauf: false }]);
  pruefe('checkerMessage (Heartbeat) wird als Text genommen', r.sink.sends[0].text === 'Neu im Postfach' && r.out[0].weg === 'teams', r.sink);
  r = await run([{ user_id: 'web:sophie', chat_id: 'web:sophie', text: '   ' }]);
  pruefe('ohne Text: weg keiner, nichts gesendet, nichts geschrieben', r.out[0].weg === 'keiner' && r.sink.sends.length === 0 && r.sink.conv.length === 0, r.out[0]);
  r = await run([{ user_id: 'telegram:1', chat_id: '1', text: 'a' }, { user_id: 'web:florian', chat_id: 'web:florian', text: 'b' }, { user_id: 'web:x', chat_id: 'web:x', text: 'c' }]);
  pruefe('drei Items -> drei Datensaetze in Reihenfolge', r.out.length === 3 && r.out.map(x => x.weg).join() === 'telegram,teams,verlauf', r.out.map(x => x.weg));

  console.log('--- Workflow-Form ---');
  const namen = wf.nodes.map(x => x.name);
  pruefe('Knoten: Trigger, Zustellen, Telegram?, Telegram senden, Ergebnis', ['Zustellung Trigger', 'Zustellen', 'Telegram?', 'Telegram senden', 'Ergebnis'].every(x => namen.includes(x)), namen);
  pruefe('Telegram? true -> Telegram senden, false -> Ergebnis', wf.connections['Telegram?'].main[0][0].node === 'Telegram senden' && wf.connections['Telegram?'].main[1][0].node === 'Ergebnis', wf.connections['Telegram?']);
  const tg = wf.nodes.find(x => x.name === 'Telegram senden');
  pruefe('Telegram senden: parse_mode HTML mit Escaping, Credential-Marker', tg.parameters.additionalFields.parse_mode === 'HTML' && /&amp;/.test(tg.parameters.text) && tg.credentials.telegramApi.name === 'Telegram Bot', tg.parameters);

  console.log('\n' + (n - f) + ' von ' + n + ' Faellen bestanden');
  process.exit(f ? 1 : 0);
})();
