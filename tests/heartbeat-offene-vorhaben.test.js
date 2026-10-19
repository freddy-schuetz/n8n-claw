// Runde 10 (19.10.2026): die Nachfrage zu offenen Vorhaben geht an die Person,
// der das Vorhaben gehoert, nicht mehr gesammelt an die Telegram-Nummer des
// Betreibers (Michaels SL-Card-Broschuere kam am 16., 17. und 18.10. bei
// Freddy an). Einmal je Vorhaben, werktags 8 bis 17 Uhr Wiener Zeit.
// Der ECHTE Code des Knotens "Load Due Actions" laeuft mit nachgebauter
// Datenschnittstelle und fester Uhrzeit.
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const wf = JSON.parse(fs.readFileSync(path.join(REPO, 'workflows/heartbeat.json'), 'utf8'));
const CODE = wf.nodes.find(n => n.name === 'Load Due Actions').parameters.jsCode
  .replace(/\{\{SUPABASE_URL\}\}/g, 'http://stub.local')
  .replace(/\{\{SUPABASE_SERVICE_KEY\}\}/g, 'stub-key')
  .replace(/\{\{TELEGRAM_CHAT_ID\}\}/g, '1810565648');

function uhr(iso) {
  const fest = new Date(iso).getTime();
  return class extends Date {
    constructor(...a) { if (a.length === 0) super(fest); else super(...a); }
    static now() { return fest; }
  };
}
const vorTagen = (iso, t) => new Date(new Date(iso).getTime() - t * 864e5).toISOString();

function vorhaben(jetzt) {
  const alt = vorTagen(jetzt, 5);
  return [
    { id: 1, owner_user_id: 'web:michael', importance: 8, created_at: alt, metadata: { source: 'agent' }, content: 'SL-Card Broschuere suchen' },
    { id: 2, owner_user_id: 'web:michael', importance: 6, created_at: alt, metadata: { source: 'agent', tags: ['x'] }, content: 'Termin mit Sara' },
    { id: 3, owner_user_id: 'entra:oid-x', importance: 6, created_at: alt, metadata: {}, content: 'Hotelbilder' },
    { id: 4, owner_user_id: 'telegram:1810565648', importance: 6, created_at: alt, metadata: null, content: 'TypeSafe Warteliste' },
    { id: 5, owner_user_id: null, importance: 9, created_at: alt, metadata: {}, content: 'ohne Besitzer' },
    { id: 6, owner_user_id: 'web:florian', importance: 9, created_at: alt, metadata: { closed: true }, content: 'erledigt' },
    { id: 7, owner_user_id: 'web:florian', importance: 9, created_at: alt, metadata: { nachgefragt_am: '2026-10-10T08:00:00Z' }, content: 'schon gefragt' },
    { id: 8, owner_user_id: 'web:sophie', importance: 5, created_at: alt, metadata: {}, content: 'A' },
    { id: 9, owner_user_id: 'web:sophie', importance: 5, created_at: alt, metadata: {}, content: 'B' },
    { id: 10, owner_user_id: 'web:sophie', importance: 5, created_at: alt, metadata: {}, content: 'C' },
    { id: 11, owner_user_id: 'web:sophie', importance: 5, created_at: alt, metadata: {}, content: 'D' },
    { id: 12, owner_user_id: 'web:fail', importance: 5, created_at: alt, metadata: {}, content: 'Vermerk scheitert' }
  ];
}

async function run(jetzt, opts) {
  opts = opts || {};
  const patches = [], abfragen = [];
  const loops = opts.loops || vorhaben(jetzt);
  const olCfg = Object.assign({ enabled: true, last_run: vorTagen(jetzt, 1.1), config: { min_age_days: 3, min_interval_hours: 24 } }, opts.ol || {});
  const helpers = {
    async httpRequest(o) {
      const url = String(o.url || '');
      const voll = b => (o.returnFullResponse ? { statusCode: 200, body: b } : b);
      if (o.method === 'PATCH' && url.includes('/memory_long?id=eq.')) {
        const id = Number(url.split('id=eq.')[1]);
        if (id === 12) throw new Error('401');
        patches.push({ id, body: o.body, auth: (o.headers || {}).Authorization });
        return '';
      }
      if (url.includes('/scheduled_actions?')) return voll(opts.actions || []);
      if (url.includes('/tasks?')) return voll([]);
      if (url.includes('/user_profiles?')) return voll([{ display_name: 'Freddy', timezone: 'Europe/Berlin', preferences: {} }]);
      if (url.includes('check_name=eq.heartbeat&')) return voll([{ enabled: false, config: {}, last_run: null }]);
      if (url.includes('check_name=eq.open_loop_check')) return voll([olCfg]);
      if (url.includes('/mcp_registry?')) return voll([]);
      if (url.includes('/memory_long?category=eq.open_loop')) { abfragen.push(url); return voll(loops); }
      if (url.includes('/conversations?user_id=eq.')) {
        const wer = decodeURIComponent(url.split('user_id=eq.')[1].split('&')[0]);
        return voll(wer === 'web:michael' ? [{ session_id: 'teams:a:MICH' }] : []);
      }
      throw new Error('unerwarteter Aufruf ' + o.method + ' ' + url);
    }
  };
  const fn = new AsyncFunction('$input', 'helpers', 'Date', CODE + '\n//# sourceURL=heartbeat.js');
  const out = await fn.call({ helpers }, { all: () => [] }, helpers, uhr(jetzt));
  const items = out.map(i => i.json).filter(j => j.heartbeat_check_name === 'open_loop_check');
  return { out: out.map(i => i.json), items, patches, abfragen };
}

let n = 0, f = 0;
function pruefe(name, ok, info) { n++; if (!ok) f++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + JSON.stringify(info).slice(0, 600))); }
const ids = msg => (String(msg).match(/\(id (\d+),/g) || []).map(x => Number(x.match(/\d+/)[0]));

(async () => {
  const MONTAG_10 = '2026-10-19T08:00:00Z';   // Montag, 10:00 in Wien (Sommerzeit)
  console.log('--- Montag 10:00 Wien ---');
  let r = await run(MONTAG_10);
  const fuer = k => r.items.filter(i => i.user_id === k);
  pruefe('Abfrage liest den Besitzer mit', r.abfragen.length === 1 && /owner_user_id/.test(r.abfragen[0]), r.abfragen);
  pruefe('Michael bekommt eine Nachricht in seinem Teams-Chat mit beiden Punkten', fuer('web:michael').length === 1 && fuer('web:michael')[0].chat_id === 'teams:a:MICH' && ids(fuer('web:michael')[0].message).join() === '1,2', fuer('web:michael'));
  pruefe('Person ohne Teams-Chat (entra:) bekommt ihre eigene Kennung als Sitzung', fuer('entra:oid-x').length === 1 && fuer('entra:oid-x')[0].chat_id === 'entra:oid-x', fuer('entra:oid-x'));
  pruefe('Telegram-Besitzer: Nummer als chat_id', fuer('telegram:1810565648').length === 1 && fuer('telegram:1810565648')[0].chat_id === '1810565648', fuer('telegram:1810565648'));
  pruefe('hoechstens drei Punkte je Person (Sophie: 8, 9, 10, nicht 11)', fuer('web:sophie').length === 1 && ids(fuer('web:sophie')[0].message).join() === '8,9,10' && fuer('web:sophie')[0].chat_id === 'web:sophie', fuer('web:sophie'));
  pruefe('ohne Besitzer, geschlossen, schon nachgefragt: keine Nachricht', !r.items.some(i => ids(i.message).some(id => [5, 6, 7].includes(id))) && fuer('web:florian').length === 0, r.items.map(i => [i.user_id, ids(i.message)]));
  pruefe('Vermerk scheitert: keine Nachricht an diese Person', fuer('web:fail').length === 0, fuer('web:fail'));
  pruefe('keine Nachricht mehr an den Betreiber fuer fremde Punkte', r.items.filter(i => i.user_id === 'telegram:1810565648').every(i => ids(i.message).join() === '4'), r.items);
  pruefe('jede Nachricht nur mit Punkten ihrer Person', r.items.every(i => ids(i.message).every(id => vorhaben(MONTAG_10).find(v => v.id === id).owner_user_id === i.user_id)), r.items.map(i => [i.user_id, ids(i.message)]));
  pruefe('Vermerk nachgefragt_am fuer jeden gefragten Punkt, mit Bearer', r.patches.map(p => p.id).sort((a, b) => a - b).join() === '1,2,3,4,8,9,10' && r.patches.every(p => p.body.metadata.nachgefragt_am === MONTAG_10.replace('Z', '.000Z') && p.auth === 'Bearer stub-key'), r.patches);
  pruefe('vorhandene metadata bleibt erhalten', (r.patches.find(p => p.id === 2) || { body: { metadata: {} } }).body.metadata.source === 'agent' && JSON.stringify(r.patches.find(p => p.id === 2).body.metadata.tags) === '["x"]', r.patches.find(p => p.id === 2));
  pruefe('Felder fuer den Agenten wie bisher (proactive_reminder, scheduled_action, always)', r.items.every(i => i.type === 'proactive_reminder' && i.source === 'scheduled_action' && i.notify_mode === 'always' && i.actionId === null), r.items);
  pruefe('Auftrag ohne Gedankenstrich', r.items.every(i => !/[–—]/.test(i.message)), r.items[0] && r.items[0].message);

  console.log('--- Zeitfenster ---');
  r = await run('2026-10-17T10:00:00Z');
  pruefe('Samstag: nichts', r.items.length === 0 && r.patches.length === 0, r.items);
  r = await run('2026-10-19T05:59:00Z');
  pruefe('Montag 07:59 Wien: nichts', r.items.length === 0, r.items);
  r = await run('2026-10-19T06:00:00Z');
  pruefe('Montag 08:00 Wien: ja', r.items.length === 4, r.items.length);
  r = await run('2026-10-19T14:59:00Z');
  pruefe('Montag 16:59 Wien: ja', r.items.length === 4, r.items.length);
  r = await run('2026-10-19T15:00:00Z');
  pruefe('Montag 17:00 Wien: nichts', r.items.length === 0, r.items);
  r = await run('2026-11-02T07:30:00Z');
  pruefe('Winterzeit: Montag 02.11. 07:30 UTC = 08:30 Wien: ja', r.items.length === 4, r.items.length);
  r = await run('2026-10-17T10:00:00Z', { ol: { config: { min_age_days: 3, min_interval_hours: 24, zeitfenster: { werktage: false } } } });
  pruefe('config.zeitfenster.werktage=false: auch samstags', r.items.length === 4, r.items.length);

  console.log('--- Takt und Schalter ---');
  r = await run(MONTAG_10, { ol: { last_run: vorTagen(MONTAG_10, 0.5) } });
  pruefe('letzter Lauf vor 12 Stunden: nichts', r.items.length === 0 && r.abfragen.length === 0, r.items);
  r = await run(MONTAG_10, { ol: { enabled: false } });
  pruefe('ausgeschaltet: nichts', r.items.length === 0 && r.abfragen.length === 0, r.items);
  r = await run(MONTAG_10, { loops: [] });
  pruefe('keine Vorhaben: no_action', r.out.length === 1 && r.out[0].type === 'no_action', r.out);
  r = await run(MONTAG_10, { actions: [{ id: 7, instruction: 'Wetter', chat_id: 'web:florian', user_id: 'web:florian', schedule: { type: 'daily', time: '08:00' }, name: 'x' }] });
  pruefe('geplante Aktionen laufen unveraendert mit', r.out.some(j => j.type === 'scheduled_action' && j.actionId === 7 && j.user_id === 'web:florian'), r.out.map(j => j.type));

  console.log('\n' + (n - f) + ' von ' + n + ' bestanden');
  process.exit(f ? 1 : 0);
})();
