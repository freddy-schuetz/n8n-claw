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
  pruefe('404 -> nicht erreichbar: nicht freigegeben oder Adresse falsch (Microsoft antwortet ohne Freigabe ebenfalls mit 404)', /nicht erreichbar/.test(r.out.error) && /nicht freigegeben/.test(r.out.error) && /Adresse/.test(r.out.error), r.out);
  r = await run(MAIL, { action: 'search_messages', mailbox: 'geheim@salzburgerland.com' }, { graph: () => { const e = new Error('Request failed with status code 403'); throw e; } });
  pruefe('403 nur in der Fehlermeldung (kein Statusfeld) -> trotzdem "nicht freigegeben"', /nicht freigegeben/.test(r.out.error), r.out);
  r = await run(MAIL, { action: 'search_messages', mailbox: 'geheim@salzburgerland.com' }, { graph: () => { const e = new Error('x'); e.response = { body: { error: { code: 'ErrorAccessDenied', message: 'Access is denied' } } }; throw e; } });
  pruefe('nur error.code ErrorAccessDenied -> "nicht freigegeben"', /nicht freigegeben/.test(r.out.error), r.out);
  r = await run(MAIL, { action: 'get_message', message_id: 'AAMkX', mailbox: 'info@salzburgerland.com' }, { graph: () => { const e = graphFehler(404); e.response.body.error.code = 'ErrorItemNotFound'; throw e; } });
  pruefe('get_message 404 ErrorItemNotFound -> Nachricht nicht gefunden, nicht "Postfach gibt es nicht"', /Nachricht wurde im Postfach info@salzburgerland.com nicht gefunden/.test(r.out.error), r.out);
  r = await run(MAIL, { action: 'reply_draft', message_id: 'AAMkX', body: 'Danke', mailbox: 'info@salzburgerland.com' }, {});
  pruefe('reply_draft mit mailbox wird klar abgelehnt (keine Schreibberechtigung)', /nur fuer Nachrichten im eigenen Postfach/.test(r.out.error) && !r.calls.some(u => u.includes('createReply')), r.out);
  r = await run(MAIL, { action: 'create_draft', subject: 'x', body: 'y', mailbox: 'info@salzburgerland.com' }, {});
  pruefe('create_draft mit mailbox wird klar abgelehnt', /nur im eigenen Postfach/.test(r.out.error), r.out);
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

  console.log('--- Kalender: Adressen aus Klammern (Carmen 11.09.2026) ---');
  // Carmens Termin ging mit "(m.rappitsch@salzburgerland.com)" an Graph, die
  // Einladung kam nie an. Der angelegte Termin wird hier mitgelesen.
  function kalenderStub(sink) {
    return (url, o) => {
      if (o.method === 'POST' && /\/me\/events$/.test(url)) { sink.body = JSON.parse(o.body); return { id: 'ev-neu' }; }
      if (o.method === 'PATCH') { sink.body = JSON.parse(o.body); return { id: 'ev1' }; }
      if (/\/me\/events\/ev1\?/.test(url)) return { id: 'ev1', subject: 'Alt', start: { dateTime: '2026-09-18T09:00:00.0000000', timeZone: 'W. Europe Standard Time' }, end: { dateTime: '2026-09-18T09:30:00.0000000', timeZone: 'W. Europe Standard Time' }, attendees: [], location: {} };
      if (/\/me\/events\/ev-neu\?/.test(url)) return { id: 'ev-neu', subject: 'Termin', start: { dateTime: '2026-09-18T10:15:00.0000000' }, end: { dateTime: '2026-09-18T10:45:00.0000000' }, attendees: (sink.body && sink.body.attendees) || [], location: {} };
      throw new Error('unerwartet ' + o.method + ' ' + url);
    };
  }
  for (const [name, eingabe, erwartet] of [
    ['runde Klammern', '(m.rappitsch@salzburgerland.com)', ['m.rappitsch@salzburgerland.com']],
    ['eckige Klammern', '[m.rappitsch@salzburgerland.com]', ['m.rappitsch@salzburgerland.com']],
    ['Name mit spitzen Klammern', 'Miriam Rappitsch <m.rappitsch@salzburgerland.com>', ['m.rappitsch@salzburgerland.com']],
    ['Name davor ohne Klammern', 'Miriam Rappitsch m.rappitsch@salzburgerland.com', ['m.rappitsch@salzburgerland.com']],
    ['zwei Personen gemischt', 'Miriam <m.rappitsch@salzburgerland.com>, (c.kurcz@salzburgerland.com)', ['m.rappitsch@salzburgerland.com', 'c.kurcz@salzburgerland.com']],
    ['saubere Adresse bleibt', 'm.rappitsch@salzburgerland.com', ['m.rappitsch@salzburgerland.com']]
  ]) {
    const sink = {};
    await run(CAL, { action: 'create_event', subject: 'Termin', start: '2026-09-18T10:15:00', end: '2026-09-18T10:45:00', attendees: eingabe, confirm: 'true' }, { graph: kalenderStub(sink) });
    const adressen = ((sink.body || {}).attendees || []).map(a => a.emailAddress.address);
    pruefe('create_event ' + name, JSON.stringify(adressen) === JSON.stringify(erwartet), { adressen, erwartet });
  }
  let r2 = await run(CAL, { action: 'create_event', subject: 'Termin', start: '2026-09-18T10:15:00', end: '2026-09-18T10:45:00', attendees: 'Miriam Rappitsch', confirm: 'true' }, {});
  pruefe('Teilnehmer ohne Adresse bleibt ein Fehler (nicht raten)', /Keine E-Mail-Adresse/.test(r2.out.error), r2.out);
  const sinkU = {};
  await run(CAL, { action: 'update_event', event_id: 'ev1', attendees: '(c.kurcz@salzburgerland.com)', confirm: 'true' }, { graph: kalenderStub(sinkU) });
  pruefe('update_event loest die Adresse ebenfalls heraus',
    JSON.stringify(((sinkU.body || {}).attendees || []).map(a => a.emailAddress.address)) === JSON.stringify(['c.kurcz@salzburgerland.com']), sinkU.body);

  console.log('--- Mail: Entwuerfe wie normale Outlook-Mails (Florian 14.09.2026) ---');
  const SIG_OWA = '<div id="Signature"><div>Mit freundlichen Gruessen<br>Florian Schumacher<br>SalzburgerLand Tourismus</div></div>';
  const SIG_DESKTOP = '<div>Liebe Gruesse<br>Florian<br>SalzburgerLand Tourismus GmbH<br>Tel. +43 662 6688</div>';
  function mailStub(sink, gesendet) {
    return (url, o) => {
      if (/mailFolders\/sentitems\/messages/.test(url)) return { value: (gesendet || []).map(h => ({ body: { content: h } })) };
      if (o.method === 'POST' && /\/me\/messages$/.test(url)) { sink.entwurf = JSON.parse(o.body); return { id: 'dr1', subject: sink.entwurf.subject }; }
      if (o.method === 'POST' && /createReply/.test(url)) return { id: 'dr2', body: { content: sink.antwortRumpf } };
      if (o.method === 'PATCH') { sink.patch = JSON.parse(o.body); return {}; }
      throw new Error('unerwartet ' + o.method + ' ' + url);
    };
  }
  let sink = {};
  let r3 = await run(MAIL, { action: 'create_draft', subject: 'Angebot', body: 'Hallo Sara,\n\nanbei die Zahlen:\n- Punkt eins\n- Punkt zwei\n\nDanke!' }, { graph: mailStub(sink, [SIG_OWA]) });
  pruefe('create_draft schickt HTML, nicht Text', sink.entwurf.body.contentType === 'html', sink.entwurf.body.contentType);
  pruefe('Outlook-Schrift im Rumpf', /font-family:Calibri/.test(sink.entwurf.body.content), sink.entwurf.body.content.slice(0, 120));
  pruefe('Absaetze als div, Aufzaehlung als ul', /<div>Hallo Sara,<\/div>/.test(sink.entwurf.body.content) && /<ul><li>Punkt eins<\/li><li>Punkt zwei<\/li><\/ul>/.test(sink.entwurf.body.content), sink.entwurf.body.content);
  pruefe('Signatur aus id="Signature" uebernommen', /Florian Schumacher/.test(sink.entwurf.body.content), sink.entwurf.body.content.slice(-200));
  pruefe('Antwort sagt, dass die Signatur dran ist', /Signatur aus den zuletzt gesendeten Mails ist angehaengt/.test(r3.out.result), r3.out.result);

  sink = {};
  r3 = await run(MAIL, { action: 'create_draft', subject: 'x', body: 'kurz' }, { graph: mailStub(sink, [SIG_DESKTOP]) });
  pruefe('Signatur ueber die Grussformel gefunden (Outlook-Desktop)', /Tel\. \+43 662 6688/.test(sink.entwurf.body.content), sink.entwurf.body.content.slice(-200));

  sink = {};
  r3 = await run(MAIL, { action: 'create_draft', subject: 'x', body: 'kurz' }, { graph: mailStub(sink, ['<div>Nur Text ohne alles</div>']) });
  pruefe('keine Signatur gefunden: ohne anlegen und das sagen',
    !/Signatur aus den zuletzt/.test(r3.out.result) && /Signatur habe ich .* nicht gefunden/.test(r3.out.result), r3.out.result);

  sink = {};
  const MIT_ZITAT = '<div>Viele Gruesse</div><div id="divRplyFwdMsg">Von: Sara</div><blockquote>alter Text</blockquote>';
  r3 = await run(MAIL, { action: 'create_draft', subject: 'x', body: 'kurz' }, { graph: mailStub(sink, [MIT_ZITAT]) });
  pruefe('zitierter Verlauf wird nicht als Signatur missverstanden', !/alter Text/.test(sink.entwurf.body.content), sink.entwurf.body.content);

  sink = {};
  r3 = await run(MAIL, { action: 'create_draft', subject: 'x', body: 'Preis < 100 & mehr' }, { graph: mailStub(sink, []) });
  pruefe('Sonderzeichen werden maskiert', /Preis &lt; 100 &amp; mehr/.test(sink.entwurf.body.content), sink.entwurf.body.content);

  console.log('--- Mail: reply_draft behaelt das Zitat ---');
  for (const [name, rumpf, muster] of [
    ['appendonsend', '<html><body><div id="appendonsend"></div><hr><div>Von: Sara</div><div>alter Text</div></body></html>', /alter Text/],
    ['divRplyFwdMsg', '<html><body><div id="divRplyFwdMsg">Von: Sara</div><div>alter Text</div></body></html>', /alter Text/],
    ['nur hr', '<html><body><hr><div>alter Text</div></body></html>', /alter Text/],
    ['leerer Rumpf', '', /Danke fuer die Zahlen/]
  ]) {
    sink = { antwortRumpf: rumpf };
    await run(MAIL, { action: 'reply_draft', message_id: 'AAMk1', body: 'Danke fuer die Zahlen' }, { graph: mailStub(sink, []) });
    pruefe('reply_draft ' + name + ': Zitat bleibt', muster.test(sink.patch.body.content), sink.patch.body.content.slice(0, 200));
    pruefe('reply_draft ' + name + ': eigener Text steht vor dem Zitat',
      sink.patch.body.content.indexOf('Danke fuer die Zahlen') < (sink.patch.body.content.indexOf('alter Text') < 0 ? Infinity : sink.patch.body.content.indexOf('alter Text')), sink.patch.body.content.slice(0, 200));
  }
  pruefe('reply_draft schickt HTML', sink.patch.body.contentType === 'html', sink.patch.body.contentType);

  console.log('--- Mail: delete_draft (Lea 15.09.2026) ---');
  function loeschStub(sink, nachricht) {
    return (url, o) => {
      if (o.method === 'GET' && /\/me\/messages\//.test(url)) {
        if (!nachricht) { const e = new Error('Request failed with status code 404'); e.httpCode = '404'; e.response = { statusCode: 404 }; throw e; }
        return nachricht;
      }
      if (o.method === 'DELETE') { sink.geloescht = url; return {}; }
      throw new Error('unerwartet ' + o.method + ' ' + url);
    };
  }
  sink = {};
  r3 = await run(MAIL, { action: 'delete_draft', message_id: 'dr1' }, { graph: loeschStub(sink, { id: 'dr1', subject: 'Angebot', isDraft: true }) });
  pruefe('Entwurf wird geloescht', /geloescht/.test(r3.out.result) && /\/me\/messages\/dr1/.test(sink.geloescht || ''), [r3.out, sink]);
  sink = {};
  r3 = await run(MAIL, { action: 'delete_draft', message_id: 'AAMk1' }, { graph: loeschStub(sink, { id: 'AAMk1', subject: 'Rechnung', isDraft: false }) });
  pruefe('echte Nachricht wird NICHT geloescht', /kein Entwurf/.test(r3.out.error) && !sink.geloescht, [r3.out, sink]);
  sink = {};
  r3 = await run(MAIL, { action: 'delete_draft', message_id: 'x' }, { graph: loeschStub(sink, null) });
  pruefe('unbekannte id: klare Meldung, kein DELETE', /gibt es im Postfach nicht/.test(r3.out.error) && !sink.geloescht, [r3.out, sink]);
  r3 = await run(MAIL, { action: 'delete_draft', message_id: 'dr1', mailbox: 'info@salzburgerland.com' }, {});
  pruefe('fremdes Postfach: abgelehnt', /nur im eigenen Postfach/.test(r3.out.error), r3.out);
  r3 = await run(MAIL, { action: 'delete_draft' }, {});
  pruefe('ohne message_id: klare Meldung', /message_id/.test(r3.out.error), r3.out);

  console.log('--- Mail: search_messages mit Ordner (Lea 15.09.2026) ---');
  function ordnerStub(sink) {
    return (url, o) => {
      if (/\/mailFolders\?/.test(url)) return { value: [{ id: 'f-in', displayName: 'Posteingang' }, { id: 'f-proj', displayName: 'Projekte' }] };
      if (/\/mailFolders\/inbox\/childFolders/.test(url)) return { value: [{ id: 'f-todo', displayName: 'ToDo' }, { id: 'f-team', displayName: 'Team' }] };
      if (/\/messages\?/.test(url)) { sink.url = url; return { value: [NACHRICHT] }; }
      throw new Error('unerwartet ' + url);
    };
  }
  sink = {};
  r3 = await run(MAIL, { action: 'search_messages', folder: 'ToDo' }, { graph: ordnerStub(sink) });
  pruefe('Unterordner des Posteingangs wird gefunden', /mailFolders\/f-todo\/messages/.test(sink.url || ''), sink.url);
  pruefe('Antwort nennt den Ordner', /im Ordner ToDo/.test(r3.out.result), r3.out.result);
  sink = {};
  await run(MAIL, { action: 'search_messages', folder: 'Projekte' }, { graph: ordnerStub(sink) });
  pruefe('Ordner der obersten Ebene wird gefunden', /mailFolders\/f-proj\/messages/.test(sink.url || ''), sink.url);
  sink = {};
  await run(MAIL, { action: 'search_messages', folder: 'Archiv' }, { graph: ordnerStub(sink) });
  pruefe('Archiv ist ein Microsoft-Standardordner, keine Suche noetig', /mailFolders\/archive\/messages/.test(sink.url || ''), sink.url);
  sink = {};
  await run(MAIL, { action: 'search_messages', folder: 'Gesendet' }, { graph: ordnerStub(sink) });
  pruefe('bekannter Name ohne Abfrage (sentitems)', /mailFolders\/sentitems\/messages/.test(sink.url || ''), sink.url);
  sink = {};
  r3 = await run(MAIL, { action: 'search_messages', folder: 'Gibtsnicht' }, { graph: ordnerStub(sink) });
  pruefe('unbekannter Ordner: Meldung mit vorhandenen Namen, keine Suche',
    /finde ich nicht/.test(r3.out.error) && /Posteingang/.test(r3.out.error) && !sink.url, [r3.out, sink]);
  sink = {};
  await run(MAIL, { action: 'search_messages', query: 'Rechnung' }, { graph: ordnerStub(sink) });
  pruefe('Regression: ohne folder unveraendert', /\/me\/messages\?/.test(sink.url || ''), sink.url);

  const mw2 = skill(MAIL).wf;
  pruefe('Server: search_messages kennt folder',
    mw2.server.nodes.find(x => x.name === 'search_messages').parameters.workflowInputs.schema.some(x => x.id === 'folder'), null);
  const dd = mw2.server.nodes.find(x => x.name === 'delete_draft');
  pruefe('Server: Werkzeug delete_draft haengt am Trigger',
    dd && dd.parameters.workflowInputs.value.action === 'delete_draft' && mw2.server.connections.delete_draft, dd && dd.parameters.workflowInputs.value);

  console.log('\n' + (n - f) + ' von ' + n + ' Faellen bestanden');
  process.exit(f ? 1 : 0);
})();
