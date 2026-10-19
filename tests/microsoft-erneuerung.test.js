// Runde 10 (19.10.2026): Microsoft-Zugaenge werden nur noch abgemeldet, wenn
// Microsoft den Zugang der Person selbst ablehnt (invalid_grant,
// interaction_required). Sonja stand seit 08.10.2026 20:00 UTC auf "neu
// verbinden" mit dem Grund "unbekannt": irgendein Fehler ohne Microsoft-Code
// (Netz, Speichern) reichte. Geprueft werden der Hintergrundlauf "MS Token
// Refresh" und der Erneuerungsweg in den Skills Kalender, Mail und SharePoint,
// jeweils der ECHTE Code mit nachgebauten Aufrufen. Die Token-Antwort kommt so
// zurueck, wie n8n sie mit returnFullResponse liefert ({ statusCode, body }).
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const ersetzen = c => c.replace(/\{\{SUPABASE_URL\}\}/g, 'http://stub.local').replace(/\{\{SUPABASE_SERVICE_KEY\}\}/g, 'k');

const CREDS = [
  { cred_key: 'tenant_id', cred_value: 't' }, { cred_key: 'client_id', cred_value: 'c' }, { cred_key: 'client_secret', cred_value: 's' },
  { cred_key: 'token_key', cred_value: 'tk' }, { cred_key: 'redirect_uri', cred_value: 'https://x/webhook/ms-oauth-callback' }, { cred_key: 'internal_domain', cred_value: '@salzburgerland.com' },
  { cred_key: 'sharepoint_sites', cred_value: JSON.stringify([{ name: 'SLT_Alle_M365', id: 'site-1' }]) }];

// Antworten des Token-Endpunkts je Fall
const FAELLE = {
  ok: () => ({ statusCode: 200, body: { access_token: 'NEU', refresh_token: 'RT2', expires_in: 3600, scope: 'x' } }),
  grant: () => ({ statusCode: 400, body: { error: 'invalid_grant', error_description: 'AADSTS70043: The refresh token has expired due to inactivity.', error_codes: [70043] } }),
  interaktion: () => ({ statusCode: 400, body: { error: 'interaction_required', error_description: 'AADSTS50076: Due to a configuration change made by your administrator, you must use multi-factor authentication.' } }),
  client: () => ({ statusCode: 401, body: { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' } }),
  netz: () => { const e = new Error('getaddrinfo EAI_AGAIN login.microsoftonline.com'); e.code = 'EAI_AGAIN'; throw e; },
  dienst: () => ({ statusCode: 503, body: '<html>Service Unavailable</html>' }),
  zeichen: () => ({ statusCode: 400, body: JSON.stringify({ error: 'invalid_grant', error_description: 'AADSTS50173: The provided grant has expired due to it being revoked.' }) })
};

let n = 0, f = 0;
function pruefe(name, ok, info) { n++; if (!ok) f++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + JSON.stringify(info).slice(0, 500))); }

// ---------------------------------------------------------------------------
// Hintergrundlauf
// ---------------------------------------------------------------------------
const REFRESH = ersetzen(JSON.parse(fs.readFileSync(path.join(REPO, 'workflows/ms-token-refresh.json'), 'utf8'))
  .nodes.find(x => x.name === 'Zugaenge auffrischen').parameters.jsCode);

async function hintergrund(personen, opts) {
  opts = opts || {};
  const marks = [], upserts = [], tokenAufrufe = [];
  const helpers = {
    async httpRequest(o) {
      const url = String(o.url || '');
      if (url.includes('template_credentials')) return CREDS;
      if (url.includes('/user_oauth_tokens?')) return personen.map(p => ({ user_key: p.key, account_id: '', scopes: 'openid offline_access' }));
      if (url.includes('rpc/get_user_token')) {
        const key = JSON.parse(o.body).p_user_key;
        const p = personen.find(x => x.key === key);
        if (p.lesefehler) throw new Error('postgrest down');
        return [{ status: 'connected', refresh_token: p.ohneRT ? null : 'RT-' + key, access_token: 'ALT', expires_at: new Date(Date.now() - 60e3).toISOString() }];
      }
      if (url.includes('login.microsoftonline.com')) {
        tokenAufrufe.push(o);
        const key = decodeURIComponent(String(o.body).split('refresh_token=')[1].split('&')[0]).slice(3);
        return FAELLE[personen.find(x => x.key === key).fall]();
      }
      if (url.includes('rpc/upsert_user_token')) {
        const b = JSON.parse(o.body);
        if (opts.upsertFehler && opts.upsertFehler.includes(b.p_user_key)) throw new Error('upsert 500');
        upserts.push(b); return 1;
      }
      if (url.includes('rpc/mark_user_token')) { marks.push(JSON.parse(o.body)); return 1; }
      throw new Error('unerwarteter Aufruf ' + url);
    }
  };
  const fn = new AsyncFunction('$input', 'helpers', REFRESH + '\n//# sourceURL=ms-token-refresh.js');
  const out = await fn({ all: () => [] }, helpers);
  return { result: out[0].json.result, marks, upserts, tokenAufrufe };
}

// ---------------------------------------------------------------------------
// Skills: Erneuerung beim Aufruf (Zugang abgelaufen)
// ---------------------------------------------------------------------------
function skillCode(file) {
  const wf = JSON.parse(fs.readFileSync(path.join(REPO, 'workflows/skills', file), 'utf8'));
  return ersetzen(wf.sub.nodes.find(x => x.type === 'n8n-nodes-base.code').parameters.jsCode);
}
const SKILLS = [
  { file: 'microsoft-calendar.json', input: { action: 'list_events', start: '2026-10-19T00:00:00', end: '2026-10-19T23:59:59' } },
  { file: 'microsoft-mail.json', input: { action: 'search_messages', query: 'Rechnung' } },
  { file: 'microsoft-sharepoint.json', input: { action: 'list_files', site: 'SLT_Alle_M365' } }
];

async function skill(s, fall, opts) {
  opts = opts || {};
  const marks = [], upserts = [], graph = [];
  const helpers = {
    async httpRequest(o) {
      const url = String(o.url || '');
      if (url.includes('template_credentials')) return CREDS;
      if (url.includes('user_identity_map')) return [{ entra_key: 'entra:mike' }];
      if (url.includes('rpc/get_user_token')) return [{ status: 'connected', access_token: 'ALT', refresh_token: 'RT', scopes: 'x', expires_at: new Date(Date.now() - 60e3).toISOString() }];
      if (url.includes('login.microsoftonline.com')) return FAELLE[fall]();
      if (url.includes('rpc/upsert_user_token')) { if (opts.upsertFehler) throw new Error('upsert 500'); upserts.push(JSON.parse(o.body)); return 1; }
      if (url.includes('rpc/mark_user_token')) { marks.push(JSON.parse(o.body)); return 1; }
      if (url.includes('graph.microsoft.com')) {
        graph.push({ url, auth: (o.headers || {}).Authorization });
        if (url.includes('/me/mailboxSettings')) return { timeZone: 'W. Europe Standard Time' };
        return { value: [] };
      }
      if (url.includes('tool_audit_log')) return '';
      throw new Error('unerwarteter Aufruf ' + url);
    }
  };
  const fn = new AsyncFunction('$input', 'helpers', skillCode(s.file) + '\n//# sourceURL=' + s.file);
  const out = await fn({ first: () => ({ json: Object.assign({ caller: 'web:mike' }, s.input) }) }, helpers);
  return { out: out[0].json, marks, upserts, graph };
}

(async () => {
  console.log('--- MS Token Refresh ---');
  const personen = [
    { key: 'entra:ok', fall: 'ok' }, { key: 'entra:grant', fall: 'grant' }, { key: 'entra:interaktion', fall: 'interaktion' },
    { key: 'entra:client', fall: 'client' }, { key: 'entra:netz', fall: 'netz' }, { key: 'entra:dienst', fall: 'dienst' },
    { key: 'entra:zeichen', fall: 'zeichen' }, { key: 'entra:ohnert', fall: 'ok', ohneRT: true }, { key: 'entra:lesen', fall: 'ok', lesefehler: true },
    { key: 'entra:speichern', fall: 'ok' }
  ];
  const r = await hintergrund(personen, { upsertFehler: ['entra:speichern'] });
  const mark = k => r.marks.filter(m => m.p_user_key === k);
  pruefe('Token-Anfrage liest die Antwort ohne Ausnahme (returnFullResponse, ignoreHttpStatusErrors)', r.tokenAufrufe.length > 0 && r.tokenAufrufe.every(o => o.returnFullResponse === true && o.ignoreHttpStatusErrors === true), r.tokenAufrufe.map(o => [o.returnFullResponse, o.ignoreHttpStatusErrors]));
  pruefe('erfolgreich: gespeichert, kein Vermerk', r.upserts.some(u => u.p_user_key === 'entra:ok' && u.p_access_token === 'NEU' && u.p_refresh_token === 'RT2') && mark('entra:ok').length === 0, { u: r.upserts, m: mark('entra:ok') });
  pruefe('invalid_grant: reconnect_required mit Microsoft-Code', mark('entra:grant').length === 1 && mark('entra:grant')[0].p_status === 'reconnect_required' && /AADSTS70043 invalid_grant/.test(mark('entra:grant')[0].p_detail), mark('entra:grant'));
  pruefe('interaction_required (MFA): reconnect_required', mark('entra:interaktion')[0] && mark('entra:interaktion')[0].p_status === 'reconnect_required' && /AADSTS50076/.test(mark('entra:interaktion')[0].p_detail), mark('entra:interaktion'));
  pruefe('Antwort als Text statt Objekt wird trotzdem gelesen', mark('entra:zeichen')[0] && mark('entra:zeichen')[0].p_status === 'reconnect_required' && /AADSTS50173/.test(mark('entra:zeichen')[0].p_detail), mark('entra:zeichen'));
  pruefe('invalid_client: bleibt connected, Grund nennt App-Zugang', mark('entra:client').length === 1 && mark('entra:client')[0].p_status === 'connected' && /App-Zugang/.test(mark('entra:client')[0].p_detail) && /AADSTS7000215/.test(mark('entra:client')[0].p_detail), mark('entra:client'));
  pruefe('Netzfehler: bleibt connected (das war Sonjas Fall)', mark('entra:netz').length === 1 && mark('entra:netz')[0].p_status === 'connected' && /EAI_AGAIN/.test(mark('entra:netz')[0].p_detail), mark('entra:netz'));
  pruefe('503: bleibt connected', mark('entra:dienst')[0] && mark('entra:dienst')[0].p_status === 'connected' && /HTTP 503/.test(mark('entra:dienst')[0].p_detail), mark('entra:dienst'));
  pruefe('kein refresh_token: reconnect_required wie bisher', mark('entra:ohnert')[0] && mark('entra:ohnert')[0].p_status === 'reconnect_required', mark('entra:ohnert'));
  pruefe('Token nicht lesbar: kein Vermerk', mark('entra:lesen').length === 0, mark('entra:lesen'));
  pruefe('Speichern scheitert nach Erneuerung: kein reconnect_required', !r.marks.some(m => m.p_user_key === 'entra:speichern' && m.p_status === 'reconnect_required'), mark('entra:speichern'));
  pruefe('Ergebnis nennt die drei Gruppen', /Erneuert: entra:ok/.test(r.result) && /Muss neu verbinden: .*entra:grant/.test(r.result) && /Naechster Lauf versucht es erneut: .*entra:netz/.test(r.result), r.result);
  pruefe('reconnect_required nur fuer invalid_grant, interaction_required und fehlenden refresh_token', r.marks.filter(m => m.p_status === 'reconnect_required').map(m => m.p_user_key).sort().join(',') === 'entra:grant,entra:interaktion,entra:ohnert,entra:zeichen', r.marks);

  for (const s of SKILLS) {
    console.log('--- Skill ' + s.file + ' ---');
    let x = await skill(s, 'ok');
    pruefe('erfolgreich erneuert: Graph mit neuem Token, gespeichert, kein Vermerk', x.graph.length > 0 && x.graph.every(g => g.auth === 'Bearer NEU') && x.upserts.length === 1 && x.marks.length === 0, x);
    x = await skill(s, 'ok', { upsertFehler: true });
    pruefe('Speichern scheitert: Aufruf laeuft trotzdem mit dem frischen Token', x.graph.length > 0 && x.graph.every(g => g.auth === 'Bearer NEU') && x.marks.length === 0 && !x.out.error, x);
    x = await skill(s, 'grant');
    pruefe('invalid_grant: reconnect_required, Link zum neu Verbinden', x.marks.length === 1 && x.marks[0].p_status === 'reconnect_required' && /neu verbinden/.test(x.out.error) && /AADSTS70043/.test(x.out.error) && x.graph.length === 0, x);
    x = await skill(s, 'netz');
    pruefe('Netzfehler: kein Vermerk, Hinweis auf spaeter, kein Link', x.marks.length === 0 && /nicht erreichbar/.test(x.out.error) && !/neu verbinden/.test(x.out.error), x);
    x = await skill(s, 'client');
    pruefe('invalid_client: kein Vermerk, "gestoert" statt neu verbinden', x.marks.length === 0 && /gestoert/.test(x.out.error) && /AADSTS7000215/.test(x.out.error) && !/neu verbinden/.test(x.out.error), x);
    x = await skill(s, 'dienst');
    pruefe('503: kein Vermerk', x.marks.length === 0 && /HTTP 503/.test(x.out.error), x);
  }

  console.log('\n' + (n - f) + ' von ' + n + ' bestanden');
  process.exit(f ? 1 : 0);
})();
