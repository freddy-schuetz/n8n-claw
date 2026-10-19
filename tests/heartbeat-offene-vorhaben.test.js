// Runde 10 und 10b (19.10.2026): die Nachfrage zu offenen Vorhaben geht an die
// Person, der das Vorhaben gehoert, nicht mehr gesammelt an die Telegram-Nummer
// des Betreibers (Michaels SL-Card-Broschuere kam am 16., 17. und 18.10. bei
// Freddy an). Einmal je Vorhaben, werktags 8 bis 17 Uhr Wiener Zeit, nicht an
// Feiertagen, hoechstens 8 Personen je Lauf, Nachfragen zuerst in der Liste,
// nur an Personen mit erreichbarem persoenlichem Chat.
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
    { id: 12, owner_user_id: 'web:fail', importance: 5, created_at: alt, metadata: {}, content: 'Vermerk scheitert' },
    { id: 13, owner_user_id: 'entra:oid-victoria', importance: 5, created_at: alt, metadata: {}, content: 'Pressetext' },
    { id: 14, owner_user_id: 'api:extern', importance: 5, created_at: alt, metadata: {}, content: 'fremdes Format' },
    { id: 15, owner_user_id: 'web:victoria', importance: 5, created_at: alt, metadata: {}, content: 'Fotofreigabe' },
    { id: 16, owner_user_id: 'web:paul', importance: 5, created_at: alt, metadata: { nachfrage_unzustellbar_am: vorTagen(jetzt, 2) }, content: 'eben unzustellbar' },
    { id: 17, owner_user_id: 'web:paul', importance: 5, created_at: alt, metadata: { nachfrage_unzustellbar_am: vorTagen(jetzt, 20) }, content: 'vor langem unzustellbar' }
  ];
}
// Zuordnung entra -> web und persoenliche Teams-Chats
const MAP = { 'entra:oid-victoria': 'web:victoria' };
const TEAMS = { 'web:michael': 'teams:a:MICH', 'web:victoria': 'teams:a:VICT', 'web:paul': 'teams:a:PAUL' };
const NUR_ID = { ITEMS: [1, 2, 4, 8, 9, 10, 13, 15, 17], UNZUSTELLBAR: [3, 14] };   // erwartete Vermerke im Grundfall

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
      if (url.includes('/user_profiles?')) return voll([{ display_name: 'Freddy', timezone: 'Europe/Berlin', preferences: { language: 'English' } }]);
      if (url.includes('check_name=eq.heartbeat&')) return voll([{ enabled: false, config: {}, last_run: null }]);
      if (url.includes('check_name=eq.open_loop_check')) return voll([olCfg]);
      if (url.includes('/mcp_registry?')) return voll([]);
      if (url.includes('/memory_long?category=eq.open_loop')) {
        abfragen.push(url);
        // Wie PostgREST: Besitzer, schon gefragt, erledigt, eben unzustellbar (14 Tage)
        const grenze = decodeURIComponent((url.match(/nachfrage_unzustellbar_am\.lt\.([^)]+)\)/) || [])[1] || '');
        return voll(opts.ungefiltert ? loops : loops.filter(l => { const m = l.metadata || {}; return l.owner_user_id && !m.nachgefragt_am && m.closed !== true && m.closed !== 'true' && (!m.nachfrage_unzustellbar_am || (grenze && m.nachfrage_unzustellbar_am < grenze)); }));
      }
      if (url.includes('/user_identity_map?entra_key=eq.')) {
        if ((o.headers || {}).Authorization !== 'Bearer stub-key') return voll({ code: '42501', message: 'permission denied for table user_identity_map' });
        if (opts.mapKaputt) return voll({ message: 'kaputt' });
        const wer = decodeURIComponent(url.split('entra_key=eq.')[1].split('&')[0]);
        const map = opts.map || MAP;
        return voll(map[wer] ? [{ legacy_key: map[wer] }] : []);
      }
      if (url.includes('/conversations?user_id=eq.')) {
        const wer = decodeURIComponent(url.split('user_id=eq.')[1].split('&')[0]);
        if (opts.convKaputt === wer) return voll({ message: 'kaputt' });
        const teams = opts.teams || TEAMS;
        return voll(teams[wer] ? [{ session_id: teams[wer] }] : []);
      }
      throw new Error('unerwarteter Aufruf ' + o.method + ' ' + url);
    }
  };
  const fn = new AsyncFunction('$input', 'helpers', 'Date', CODE + '\n//# sourceURL=heartbeat.js');
  const out = await fn.call({ helpers }, { all: () => [] }, helpers, uhr(jetzt));
  const alle = out.map(i => i.json);
  const items = alle.filter(j => j.heartbeat_check_name === 'open_loop_check');
  return { out: alle, items, patches, abfragen };
}

let n = 0, f = 0;
function pruefe(name, ok, info) { n++; if (!ok) f++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + JSON.stringify(info).slice(0, 600))); }
const ids = msg => (String(msg).match(/\(id (\d+),/g) || []).map(x => Number(x.match(/\d+/)[0]));

(async () => {
  const MONTAG_10 = '2026-10-19T08:00:00Z';   // Montag, 10:00 in Wien (Sommerzeit)
  console.log('--- Montag 10:00 Wien ---');
  let r = await run(MONTAG_10);
  const fuer = k => r.items.filter(i => i.user_id === k);
  pruefe('Abfrage liest den Besitzer mit und filtert in der Datenbank (Besitzer, schon gefragt, erledigt, eben unzustellbar)',
    r.abfragen.length === 1 && /owner_user_id/.test(r.abfragen[0]) && /owner_user_id=not\.is\.null/.test(r.abfragen[0]) && /metadata-%3E%3Enachgefragt_am=is\.null/.test(r.abfragen[0]) && /metadata-%3E%3Eclosed\.neq\.true/.test(r.abfragen[0]) && /nachfrage_unzustellbar_am\.lt\.2026-10-05T08:00:00/.test(r.abfragen[0]), r.abfragen);
  pruefe('Michael bekommt eine Nachricht in seinem Teams-Chat mit beiden Punkten', fuer('web:michael').length === 1 && fuer('web:michael')[0].chat_id === 'teams:a:MICH' && ids(fuer('web:michael')[0].message).join() === '1,2', fuer('web:michael'));
  pruefe('entra: mit Web-Zuordnung laeuft als web:victoria; Vorhaben unter beiden Kennungen in EINER Nachricht', fuer('web:victoria').length === 1 && fuer('web:victoria')[0].chat_id === 'teams:a:VICT' && ids(fuer('web:victoria')[0].message).sort().join() === '13,15', fuer('web:victoria'));
  pruefe('Zuordnung mit Dienstschluessel gelesen (anon ist gesperrt)', r.items.some(i => i.user_id === 'web:victoria'), r.items.map(i => i.user_id));
  pruefe('entra: ohne persoenlichen Chat und fremdes Format: keine Nachfrage, Vermerk unzustellbar', fuer('entra:oid-x').length === 0 && fuer('api:extern').length === 0 && r.patches.filter(p => p.body.metadata.nachfrage_unzustellbar_am === MONTAG_10.replace('Z', '.000Z')).map(p => p.id).sort((a, b) => a - b).join() === NUR_ID.UNZUSTELLBAR.join() && !r.patches.some(p => (p.id === 3 || p.id === 14) && p.body.metadata.nachgefragt_am), r.patches);
  pruefe('eben unzustellbar: diesmal nicht; vor mehr als 14 Tagen unzustellbar: neuer Versuch', !r.items.some(i => ids(i.message).includes(16)) && r.items.some(i => ids(i.message).includes(17)), r.items.map(i => [i.user_id, ids(i.message)]));
  pruefe('Telegram-Besitzer: Nummer als chat_id', fuer('telegram:1810565648').length === 1 && fuer('telegram:1810565648')[0].chat_id === '1810565648', fuer('telegram:1810565648'));
  pruefe('hoechstens drei Punkte je Person (Sophie: 8, 9, 10, nicht 11), Web-Sitzung ohne Teams-Chat', fuer('web:sophie').length === 1 && ids(fuer('web:sophie')[0].message).join() === '8,9,10' && fuer('web:sophie')[0].chat_id === 'web:sophie', fuer('web:sophie'));
  pruefe('ohne Besitzer, geschlossen, schon nachgefragt: keine Nachricht', !r.items.some(i => ids(i.message).some(id => [5, 6, 7].includes(id))) && fuer('web:florian').length === 0, r.items.map(i => [i.user_id, ids(i.message)]));
  pruefe('Vermerk scheitert: keine Nachricht an diese Person', fuer('web:fail').length === 0, fuer('web:fail'));
  pruefe('jede Nachricht nur mit Punkten ihrer Person', r.items.every(i => ids(i.message).every(id => { const o = vorhaben(MONTAG_10).find(v => v.id === id).owner_user_id; return o === i.user_id || MAP[o] === i.user_id; })), r.items.map(i => [i.user_id, ids(i.message)]));
  pruefe('Vermerk nachgefragt_am nur fuer gesendete Punkte, mit Bearer', r.patches.filter(p => p.body.metadata.nachgefragt_am).map(p => p.id).sort((a, b) => a - b).join() === NUR_ID.ITEMS.join() && r.patches.every(p => p.auth === 'Bearer stub-key') && r.patches.filter(p => p.body.metadata.nachgefragt_am).every(p => p.body.metadata.nachgefragt_am === MONTAG_10.replace('Z', '.000Z')), r.patches.map(p => p.id));
  pruefe('vorhandene metadata bleibt erhalten', (r.patches.find(p => p.id === 2) || { body: { metadata: {} } }).body.metadata.source === 'agent' && JSON.stringify(r.patches.find(p => p.id === 2).body.metadata.tags) === '["x"]', r.patches.find(p => p.id === 2));
  pruefe('Felder fuer den Agenten wie bisher (proactive_reminder, scheduled_action, always)', r.items.every(i => i.type === 'proactive_reminder' && i.source === 'scheduled_action' && i.notify_mode === 'always' && i.actionId === null), r.items);
  pruefe('Auftrag ohne Gedankenstrich und ohne Sprache aus dem Betreiberprofil', r.items.every(i => !/[–—]/.test(i.message) && !/Antworte auf/.test(i.message) && !/English/.test(i.message)), r.items[0] && r.items[0].message);
  pruefe('Auftrag beginnt wie bisher (der Agent erkennt daran die Nachfrage)', r.items.every(i => /^Du fragst proaktiv beim User nach alten offenen Vorhaben\./.test(i.message)), r.items[0] && r.items[0].message.slice(0, 80));

  console.log('--- Reihenfolge und Grenze ---');
  r = await run(MONTAG_10, { actions: [{ id: 7, instruction: 'Wetter', chat_id: 'web:florian', user_id: 'web:florian', schedule: { type: 'daily', time: '08:00' }, name: 'x' }] });
  const typen = r.out.map(j => j.type);
  pruefe('Nachfragen stehen vor den geplanten Aktionen', typen.indexOf('scheduled_action') > typen.lastIndexOf('proactive_reminder') && typen[0] === 'proactive_reminder', typen);
  pruefe('geplante Aktionen laufen unveraendert mit', r.out.some(j => j.type === 'scheduled_action' && j.actionId === 7 && j.user_id === 'web:florian'), typen);
  const viele = Array.from({ length: 12 }, (_, i) => ({ id: 100 + i, owner_user_id: 'web:p' + i, importance: 5, created_at: vorTagen(MONTAG_10, 5), metadata: {}, content: 'Punkt ' + i }));
  r = await run(MONTAG_10, { loops: viele });
  pruefe('hoechstens 8 Personen je Lauf, die uebrigen bleiben unvermerkt', r.items.length === 8 && r.patches.length === 8 && !r.patches.some(p => p.id >= 108), { n: r.items.length, p: r.patches.map(p => p.id) });
  r = await run(MONTAG_10, { loops: viele, ol: { config: { min_age_days: 3, min_interval_hours: 24, max_personen: 3 } } });
  pruefe('config.max_personen greift', r.items.length === 3, r.items.length);
  r = await run(MONTAG_10, { mapKaputt: true });
  pruefe('Zuordnung nicht lesbar: entra-Besitzer diesmal ohne Nachfrage und ohne Vermerk, andere normal', !r.items.some(i => i.user_id === 'web:victoria' && ids(i.message).includes(13)) && !r.patches.some(p => p.id === 13 || p.id === 3) && r.items.some(i => i.user_id === 'web:michael'), { items: r.items.map(i => [i.user_id, ids(i.message)]), patches: r.patches.map(p => p.id) });
  r = await run('2026-12-24T09:00:00Z', { ol: { config: { min_age_days: 3, min_interval_hours: 24, zeitfenster: { feiertage: ['24.12.2026', '2026-12-31T00:00:00Z'] } } } });
  pruefe('config.zeitfenster.feiertage auch als DD.MM.YYYY', r.items.length === 0, r.items.length);
  r = await run('2026-12-31T09:00:00Z', { ol: { config: { min_age_days: 3, min_interval_hours: 24, zeitfenster: { feiertage: ['24.12.2026', '2026-12-31T00:00:00Z'] } } } });
  pruefe('config.zeitfenster.feiertage nimmt die ersten 10 Zeichen eines Zeitstempels', r.items.length === 0, r.items.length);
  r = await run(MONTAG_10, { convKaputt: 'web:michael' });
  pruefe('Teams-Chat nicht lesbar: diese Person diesmal ohne Nachfrage und ohne Vermerk', !r.items.some(i => i.user_id === 'web:michael') && !r.patches.some(p => p.id === 1 || p.id === 2), r.items.map(i => i.user_id));

  console.log('--- Zeitfenster und Feiertage ---');
  r = await run('2026-10-17T10:00:00Z');
  pruefe('Samstag: nichts', r.items.length === 0 && r.patches.length === 0, r.items);
  r = await run('2026-10-19T05:59:00Z');
  pruefe('Montag 07:59 Wien: nichts', r.items.length === 0, r.items);
  r = await run('2026-10-19T06:00:00Z');
  pruefe('Montag 08:00 Wien: ja', r.items.length === 5, r.items.length);
  r = await run('2026-10-19T14:59:00Z');
  pruefe('Montag 16:59 Wien: ja', r.items.length === 5, r.items.length);
  r = await run('2026-10-19T15:00:00Z');
  pruefe('Montag 17:00 Wien: nichts', r.items.length === 0, r.items);
  r = await run('2026-11-02T07:30:00Z');
  pruefe('Winterzeit: Montag 02.11. 07:30 UTC = 08:30 Wien: ja', r.items.length === 5, r.items.length);
  for (const [tag, iso] of [['Nationalfeiertag Mo 26.10.2026', '2026-10-26T09:00:00Z'], ['Mariae Empfaengnis Di 08.12.2026', '2026-12-08T09:00:00Z'],
    ['Ostermontag 29.03.2027', '2027-03-29T08:00:00Z'], ['Christi Himmelfahrt 06.05.2027', '2027-05-06T08:00:00Z'], ['Pfingstmontag 17.05.2027', '2027-05-17T08:00:00Z'],
    ['Fronleichnam 27.05.2027', '2027-05-27T08:00:00Z'], ['Stefanitag Sa 26.12.2026 (Wochenende ohnehin)', '2026-12-26T09:00:00Z'], ['Neujahr Fr 01.01.2027', '2027-01-01T09:00:00Z']]) {
    r = await run(iso);
    pruefe(tag + ': nichts', r.items.length === 0, r.items.length);
  }
  r = await run('2026-10-27T09:00:00Z');
  pruefe('Di 27.10.2026 (kein Feiertag): ja', r.items.length === 5, r.items.length);
  r = await run('2026-10-27T09:00:00Z', { ol: { config: { min_age_days: 3, min_interval_hours: 24, zeitfenster: { feiertage: ['2026-10-27'] } } } });
  pruefe('config.zeitfenster.feiertage sperrt zusaetzliche Tage', r.items.length === 0, r.items.length);
  r = await run('2026-10-17T10:00:00Z', { ol: { config: { min_age_days: 3, min_interval_hours: 24, zeitfenster: { werktage: false } } } });
  pruefe('config.zeitfenster.werktage=false: auch samstags', r.items.length === 5, r.items.length);

  console.log('--- Takt und Schalter ---');
  r = await run(MONTAG_10, { ol: { last_run: vorTagen(MONTAG_10, 0.5) } });
  pruefe('letzter Lauf vor 12 Stunden: nichts', r.items.length === 0 && r.abfragen.length === 0, r.items);
  r = await run(MONTAG_10, { ol: { enabled: false } });
  pruefe('ausgeschaltet: nichts', r.items.length === 0 && r.abfragen.length === 0, r.items);
  r = await run(MONTAG_10, { loops: [] });
  pruefe('keine Vorhaben: no_action', r.out.length === 1 && r.out[0].type === 'no_action', r.out);

  console.log('--- Dritte Gegenlese: Microsoft aus Telegram verbunden ---');
  // Der juengste Schluessel zur Entra-Kennung ist telegram:<nummer>; der Adapter legt
  // dann auch die Teams-Zeilen unter dieser Kennung ab. Der Agent behandelt jede
  // telegram:-Kennung als Telegram: ein Teams-Chat als Ziel liefe ins Leere.
  const fl = [
    { id: 21, owner_user_id: 'entra:oid-freddy', importance: 6, created_at: vorTagen(MONTAG_10, 5), metadata: {}, content: 'Teams-Vorhaben' },
    { id: 22, owner_user_id: 'telegram:1810565648', importance: 6, created_at: vorTagen(MONTAG_10, 5), metadata: {}, content: 'Telegram-Vorhaben' }
  ];
  r = await run(MONTAG_10, { loops: fl, map: { 'entra:oid-freddy': 'telegram:1810565648' }, teams: { 'telegram:1810565648': 'teams:a:FREDDY' } });
  pruefe('entra: mit juengstem Schluessel telegram: geht nach Telegram (Nummer), nicht in den Teams-Chat; beide Punkte in EINER Nachricht',
    r.items.length === 1 && r.items[0].user_id === 'telegram:1810565648' && r.items[0].chat_id === '1810565648' && ids(r.items[0].message).sort().join() === '21,22', r.items);
  r = await run(MONTAG_10, { loops: fl.slice(0, 1), map: { 'entra:oid-freddy': 'telegram:1810565648' }, teams: {} });
  pruefe('dasselbe ohne Teams-Zeile: Telegram, nicht unzustellbar',
    r.items.length === 1 && r.items[0].chat_id === '1810565648' && !r.patches.some(p => p.body.metadata.nachfrage_unzustellbar_am), { items: r.items, patches: r.patches });

  console.log('\n' + (n - f) + ' von ' + n + ' bestanden');
  process.exit(f ? 1 : 0);
})();
