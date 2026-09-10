// Runde 6 (10.09.2026): fremde Postfaecher (mailbox) im Mail-Skill und Termine
// von Kolleg:innen mit Details (colleague_events) im Kalender-Skill. Simon hat
// Mail.Read.Shared und Calendars.Read.Shared erteilt; beides wirkt nur dort, wo
// in Outlook freigegeben ist, sonst 403. Der ECHTE Skill-Code laeuft mit
// gefaelschten HTTP-Aufrufen (Zugangsdaten, Zuordnung, Token, Graph).
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function skill(file) {
  const wf = JSON.parse(fs.readFileSync(path.join(REPO, 'workflows/skills', file), 'utf8'));
  const n = wf.sub.nodes.find(x => x.type === 'n8n-nodes-base.code');
  return { code: n.parameters.jsCode.replace(/\{\{SUPABASE_URL\}\}/g, 'http://stub.local').replace(/\{\{SUPABASE_SERVICE_KEY\}\}/g, 'k'), wf };
}
function graphFehler(status) {
  const e = new Error('Request failed with status code ' + status);
  e.httpCode = String(status);
  e.response = { statusCode: status, body: { error: { code: status === 403 ? 'ErrorAccessDenied' : 'ErrorItemNotFound', message: status === 403 ? 'Access is denied. Check credentials and try again.' : 'The specified object was not found in the store.' } } };
  return e;
}
async function run(file, input, opts) {
  opts = opts || {};
  const calls = [];
  const helpers = {
    async httpRequest(o) {
      const url = String(o.url || '');
      calls.push(url);
      if (url.includes('template_credentials')) return [
        { cred_key: 'tenant_id', cred_value: 't' }, { cred_key: 'client_id', cred_value: 'c' }, { cred_key: 'client_secret', cred_value: 's' },
        { cred_key: 'token_key', cred_value: 'tk' }, { cred_key: 'redirect_uri', cred_value: 'https://x/webhook/ms-oauth-callback' }, { cred_key: 'internal_domain', cred_value: '@salzburgerland.com' }];
      if (url.includes('user_identity_map')) return [{ entra_key: 'entra:mike' }];
      if (url.includes('rpc/get_user_token')) return [{ status: 'connected', access_token: 'TOKEN', expires_at: new Date(Date.now() + 3600e3).toISOString(), scopes: 'x' }];
      if (url.includes('/me/mailboxSettings')) return { timeZone: 'W. Europe Standard Time' };
      if (opts.graph) return opts.graph(url, o);
      throw new Error('unerwarteter Aufruf ' + url);
    }
  };
  const fn = new AsyncFunction('$input', 'helpers', skill(file).code + '\n//# sourceURL=' + file);
  const out = await fn({ first: () => ({ json: Object.assign({ caller: 'web:mike' }, input) }) }, helpers);
  return { out: out[0].json, calls };
}
let n = 0, f = 0;
function pruefe(name, ok, info) { n++; if (!ok) f++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + JSON.stringify(info).slice(0, 400))); }

const MAIL = 'microsoft-mail.json', CAL = 'microsoft-calendar.json';
const NACHRICHT = { id: 'AAMk1', subject: 'Rechnung', from: { emailAddress: { name: 'Sara', address: 's.x@salzburgerland.com' } }, receivedDateTime: '2026-09-10T08:00:00Z', bodyPreview: 'Hallo', isRead: false };

(async () => {
  console.log('--- Mail: eigenes Postfach unveraendert ---');
  let r = await run(MAIL, { action: 'search_messages', query: 'Rechnung' }, { graph: (url) => { if (url.includes('/me/messages?')) return { value: [NACHRICHT] }; throw new Error('x ' + url); } });
  pruefe('ohne mailbox: /me/messages', r.calls.some(u => u.includes('/v1.0/me/messages?')) && /1 Nachrichten:/.test(r.out.result), r);

  console.log('--- Mail: fremdes Postfach ---');
  r = await run(MAIL, { action: 'search_messages', query: 'Rechnung', mailbox: 'Info@SalzburgerLand.com' }, { graph: (url) => { if (url.includes('/users/info%40salzburgerland.com/messages?')) return { value: [NACHRICHT] }; throw new Error('x ' + url); } });
  pruefe('mailbox: /users/{adresse}/messages, Adresse kleingeschrieben, Postfach in der Antwort', r.calls.some(u => u.includes('/users/info%40salzburgerland.com/messages?')) && /im Postfach info@salzburgerland.com/.test(r.out.result), r);
  r = await run(MAIL, { action: 'get_message', message_id: 'AAMk1', mailbox: 'info@salzburgerland.com' }, { graph: (url) => { if (url.includes('/users/info%40salzburgerland.com/messages/AAMk1')) return { subject: 'Rechnung', from: { emailAddress: { address: 's@x' } }, toRecipients: [], receivedDateTime: '2026-09-10T08:00:00Z', body: { content: '<p>Hallo</p>' } }; throw new Error('x ' + url); } });
  pruefe('get_message mit mailbox liest aus dem fremden Postfach', /Betreff: Rechnung/.test(r.out.result) && /Hallo/.test(r.out.result), r.out);
  r = await run(MAIL, { action: 'search_messages', mailbox: 'geheim@salzburgerland.com' }, { graph: () => { throw graphFehler(403); } });
  pruefe('403 -> "nicht freigegeben", keine Rohmeldung', /nicht freigegeben/.test(r.out.error) && !/status code/.test(r.out.error), r.out);
  r = await run(MAIL, { action: 'search_messages', mailbox: 'gibtsnicht@salzburgerland.com' }, { graph: () => { throw graphFehler(404); } });
  pruefe('404 -> "gibt es im Mandanten nicht"', /gibt es im Mandanten nicht/.test(r.out.error), r.out);
  r = await run(MAIL, { action: 'search_messages', mailbox: 'Sara' }, {});
  pruefe('mailbox ohne @ wird abgewiesen, bevor Graph gefragt wird', /muss eine E-Mail-Adresse sein/.test(r.out.error) && !r.calls.some(u => u.includes('graph.microsoft.com/v1.0/users')), r.out);
  r = await run(MAIL, { action: 'search_messages' }, { graph: () => { throw graphFehler(403); } });
  pruefe('403 im eigenen Postfach bleibt der alte Fehlerweg (kein "nicht freigegeben")', /Microsoft Postfach/.test(r.out.error) && !/nicht freigegeben/.test(r.out.error), r.out);
  const mw = skill(MAIL).wf;
  for (const name of ['search_messages', 'get_message']) {
    const s = mw.server.nodes.find(x => x.name === name);
    pruefe(name + ': Schema kennt mailbox', s.parameters.workflowInputs.schema.some(x => x.id === 'mailbox') && /fromAI\('mailbox'/.test(s.parameters.workflowInputs.value.mailbox), s.parameters.workflowInputs.schema.map(x => x.id));
  }

  console.log('--- Kalender: colleague_events ---');
  const EV = { id: 'ev1', subject: 'Jour fixe', start: { dateTime: '2026-09-11T09:00:00.0000000' }, end: { dateTime: '2026-09-11T10:00:00.0000000' }, location: { displayName: 'Raum 2' }, attendees: [{ emailAddress: { name: 'Michael Gassner' } }] };
  r = await run(CAL, { action: 'colleague_events', for_email: 'h.traussnigg@salzburgerland.com' }, { graph: (url) => { if (url.includes('/users/h.traussnigg%40salzburgerland.com/calendarView?')) return { value: [EV] }; throw new Error('x ' + url); } });
  pruefe('Termine mit Betreff, Ort und Teilnehmenden aus /users/{adresse}/calendarView', /1 Termine von h.traussnigg@salzburgerland.com/.test(r.out.result) && /Jour fixe/.test(r.out.result) && /\[Raum 2\]/.test(r.out.result) && /mit Michael Gassner/.test(r.out.result), r.out);
  r = await run(CAL, { action: 'colleague_events', for_email: 'h.traussnigg@salzburgerland.com' }, { graph: () => { throw graphFehler(403); } });
  pruefe('403 -> Kalender nicht freigegeben, Hinweis auf colleague_schedule und Outlook-Freigabe', /nicht freigegeben/.test(r.out.error) && /colleague_schedule/.test(r.out.error) && /Outlook/.test(r.out.error), r.out);
  r = await run(CAL, { action: 'colleague_events', for_email: 'a@x.com, b@x.com' }, {});
  pruefe('mehr als eine Adresse wird abgewiesen', /genau eine E-Mail-Adresse/.test(r.out.error), r.out);
  r = await run(CAL, { action: 'colleague_events' }, {});
  pruefe('ohne for_email klare Meldung', /for_email/.test(r.out.error), r.out);
  r = await run(CAL, { action: 'colleague_events', for_email: 'h.traussnigg@salzburgerland.com' }, { graph: () => ({ value: [] }) });
  pruefe('keine Termine -> ruhige Antwort', /Keine Termine von h.traussnigg/.test(r.out.result), r.out);
  const cw = skill(CAL).wf;
  const ce = cw.server.nodes.find(x => x.name === 'colleague_events');
  pruefe('Server: colleague_events als Werkzeug am Trigger', ce && ce.parameters.workflowInputs.value.action === 'colleague_events' && cw.server.connections.colleague_events && ce.parameters.workflowInputs.schema.some(x => x.id === 'for_email'), ce && ce.parameters.workflowInputs);
  pruefe('colleague_schedule bleibt', cw.server.nodes.some(x => x.name === 'colleague_schedule'));
  r = await run(CAL, { action: 'list_events' }, { graph: (url) => { if (url.includes('/me/calendarView?')) return { value: [EV] }; throw new Error('x ' + url); } });
  pruefe('Regression: list_events unveraendert', /1 Termine \(Zeitzone/.test(r.out.result), r.out);

  console.log('\n' + (n - f) + ' von ' + n + ' Faellen bestanden');
  process.exit(f ? 1 : 0);
})();
