// Runde 6 (10.09.2026): Erinnerungen und Aufgaben gehoeren der Person, die sie
// anlegt, nicht dem Betreiber. Geprueft wird der ECHTE Code aus den Workflow-
// Dateien: Task Manager (Agent), Format Task Input (Agent), Save Reminder
// (Factory), Check Reminders und Mark Done (Runner), dazu die Form der Knoten
// (Reminder-Schema, Router, Zustellen-Knoten in Runner und Heartbeat).
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function wf(file) { return JSON.parse(fs.readFileSync(path.join(REPO, file), 'utf8')); }
function code(file, nodeName) {
  const n = wf(file).nodes.find(x => x.name === nodeName);
  if (!n || !n.parameters.jsCode) throw new Error(nodeName + ' fehlt in ' + file);
  return n.parameters.jsCode
    .replace(/\{\{SUPABASE_URL\}\}/g, 'http://stub.local')
    .replace(/\{\{SUPABASE_SERVICE_KEY\}\}/g, 'stub-key')
    .replace(/\{\{TELEGRAM_CHAT_ID\}\}/g, '1810565648');
}
let n = 0, f = 0;
function pruefe(name, ok, info) { n++; if (!ok) f++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + JSON.stringify(info).slice(0, 400))); }
const AGENT = 'workflows/n8n-claw-agent.json';

(async () => {
  console.log('--- Task Manager: Liste je Person ---');
  {
    const CODE = code(AGENT, 'Task Manager');
    async function tm(query, identity) {
      const calls = [];
      const helpers = { async httpRequest(o) { calls.push({ method: o.method, url: o.url, body: o.body ? JSON.parse(o.body) : null }); return { body: JSON.stringify([{ id: 7, user_id: 'x' }]) }; } };
      const $ = () => ({ first: () => { if (identity === undefined) throw new Error('kein Merge Input'); return { json: identity }; } });
      const fn = new AsyncFunction('query', 'helpers', '$', CODE + '\n//# sourceURL=task-manager.js');
      const out = await fn(JSON.stringify(query), helpers, $);
      return { out: String(out), calls };
    }
    let r = await tm({ action: 'create', title: 'Billing-Nummer aendern', due_date: '2026-09-30T09:00:00+02:00' }, { qualifiedUserId: 'web:florian', sessionId: 'teams:a:x' });
    pruefe('create speichert unter der fragenden Person', r.calls[0].method === 'POST' && r.calls[0].body.user_id === 'web:florian', r.calls[0]);
    r = await tm({ action: 'list' }, { qualifiedUserId: 'web:hannah' });
    pruefe('list filtert auf die fragende Person', /user_id=eq\.web%3Ahannah/.test(r.calls[0].url), r.calls[0].url);
    r = await tm({ action: 'update', id: 2, status: 'done' }, { qualifiedUserId: 'web:florian' });
    pruefe('update haengt die Kennung als Filter an (fremde Aufgaben unerreichbar)', /id=eq\.2&user_id=eq\.web%3Aflorian/.test(r.calls[0].url), r.calls[0].url);
    r = await tm({ action: 'delete', id: 2 }, { qualifiedUserId: 'web:florian' });
    pruefe('delete ebenso', /user_id=eq\.web%3Aflorian/.test(r.calls[0].url), r.calls[0].url);
    r = await tm({ action: 'create', title: 'x' }, undefined);
    pruefe('ohne Merge Input: alter Telegram-Rueckfall', r.calls[0].body.user_id === 'telegram:1810565648', r.calls[0]);
    r = await tm({ action: 'create', title: 'x' }, { qualifiedUserId: 'telegram:555' });
    pruefe('Telegram-Person: eigene Kennung, nicht die des Betreibers', r.calls[0].body.user_id === 'telegram:555', r.calls[0]);
    const desc = wf(AGENT).nodes.find(x => x.name === 'Task Manager').parameters.description;
    pruefe('Beschreibung: je Person, keine Benachrichtigung, Reminder fuer Zeitpunkte', /own list/.test(desc) && /NO notification/.test(desc) && /Reminder tool/.test(desc), desc.slice(0, 200));
  }

  console.log('--- Format Task Input: Web und Teams behalten ihre Kennung ---');
  {
    const CODE = code(AGENT, 'Format Task Input');
    async function fti(json) {
      const fn = new AsyncFunction('$input', CODE);
      return (await fn({ first: () => ({ json }) }))[0].json;
    }
    let o = await fti({ message: 'Erinnerung', chat_id: '1810565648', user_id: 'telegram:1810565648', source: 'scheduled_task' });
    pruefe('Telegram wie bisher', o.chatId === '1810565648' && o.sessionId === 'telegram:1810565648' && o.qualifiedUserId === 'telegram:1810565648' && o.userId === '1810565648' && o._scheduled === true, o);
    o = await fti({ message: 'Erinnerung', chat_id: '77', user_id: '77' });
    pruefe('nackte Nummer (alte Zeilen) -> Telegram', o.qualifiedUserId === 'telegram:77' && o.sessionId === 'telegram:77', o);
    o = await fti({ message: 'Pruefe Vexa', chat_id: 'teams:a:1bug', user_id: 'web:florian', source: 'scheduled_task' });
    pruefe('Teams-Person: Kennung bleibt web:florian, Sitzung ist der Teams-Chat, kein chatId', o.qualifiedUserId === 'web:florian' && o.userId === 'web:florian' && o.sessionId === 'teams:a:1bug' && o.chatId === null, o);
    o = await fti({ message: 'x', chat_id: 'web:hannah', user_id: 'web:hannah' });
    pruefe('Web-Person: Sitzung web:hannah', o.sessionId === 'web:hannah' && o.qualifiedUserId === 'web:hannah' && o.chatId === null, o);
    o = await fti({ message: 'x', chat_id: '', user_id: 'web:hannah' });
    pruefe('ohne chat_id faellt die Sitzung auf die Kennung zurueck', o.sessionId === 'web:hannah', o);
  }

  console.log('--- Response Router und Zustellen im Agenten ---');
  {
    const a = wf(AGENT);
    const rr = a.nodes.find(x => x.name === 'Response Router');
    const tele = rr.parameters.rules.values[2];
    pruefe('Telegram-Regel verlangt jetzt eine Chat-Nummer', tele.outputKey === 'Telegram' && tele.conditions.conditions.length === 2 && /chatId/.test(tele.conditions.conditions[1].leftValue) && tele.conditions.conditions[1].operator.operation === 'notEmpty', tele);
    pruefe('Webhook- und Stream-Regel unveraendert', rr.parameters.rules.values[0].outputKey === 'Webhook' && rr.parameters.rules.values[0].conditions.conditions.length === 1 && rr.parameters.rules.values[1].outputKey === 'Stream', rr.parameters.rules.values.map(v => v.outputKey));
    const c = a.connections['Response Router'].main;
    pruefe('Fallback-Ausgang (Index 3) -> Zustellung vorbereiten -> Zustellen', c.length === 4 && c[3][0].node === 'Zustellung vorbereiten' && a.connections['Zustellung vorbereiten'].main[0][0].node === 'Zustellen', c);
    pruefe('alte Ausgaenge unveraendert', c[0][0].node === 'Respond to Webhook' && c[1].length === 0 && c[2][0].node === 'Detect File Send', c);
    const zn = a.nodes.find(x => x.name === 'Zustellen');
    pruefe('Zustellen zeigt auf REPLACE_ZUSTELLUNG_ID und wartet', zn.parameters.workflowId.value === 'REPLACE_ZUSTELLUNG_ID' && zn.parameters.options.waitForSubWorkflow === true && !zn.parameters.workflowInputs, zn.parameters);
    pruefe('Telegram Status ist weg', !a.nodes.some(x => x.name === 'Telegram Status') && !a.connections['Telegram Status'], a.nodes.map(x => x.name).filter(x => /Telegram/.test(x)));
    // Zustellung vorbereiten mit echtem Code
    const CODE = code(AGENT, 'Zustellung vorbereiten');
    const fn = new AsyncFunction('$', CODE);
    const mk = (out) => (name) => ({ first: () => ({ json: name === 'Build System Prompt' ? { qualifiedUserId: 'web:florian', sessionId: 'teams:a:1bug' } : { output: out } }) });
    let o = await fn(mk('Ergebnis: alles gut'));
    pruefe('Zustellung vorbereiten: Kennung, Sitzung, Text, im_verlauf', o.length === 1 && o[0].json.user_id === 'web:florian' && o[0].json.chat_id === 'teams:a:1bug' && o[0].json.text === 'Ergebnis: alles gut' && o[0].json.im_verlauf === true && o[0].json.art === 'geplant', o);
    o = await fn(mk('   '));
    pruefe('leere Antwort -> nichts zuzustellen', o.length === 0, o);
    // Reminder-Werkzeug: Schema mit Kennung
    const rem = a.nodes.find(x => x.name === 'Reminder');
    const wi = rem.parameters.workflowInputs;
    const ids = wi.schema.map(s => s.id);
    pruefe('Reminder-Schema traegt time/message/type/action und die Kennungsfelder', ['time', 'message', 'type', 'action', 'target_id', 'schedule', 'userId', 'chatId', 'sessionId'].every(k => ids.includes(k)), ids);
    pruefe('Kennung kommt aus Merge Input, nicht vom Modell', /Merge Input.*qualifiedUserId/.test(wi.value.userId) && /Merge Input/.test(wi.value.chatId) && !/fromAI/.test(wi.value.userId), wi.value);
    pruefe('Modellfelder ueber $fromAI', /fromAI\('time'/.test(wi.value.time) && /fromAI\('message'/.test(wi.value.message), wi.value);
    pruefe('Beschreibung verspricht kein Telegram mehr und verlangt den Zustellweg aus der Antwort', !/sends a Telegram message/.test(rem.parameters.description) && /names the delivery channel/.test(rem.parameters.description), rem.parameters.description.slice(0, 300));
    // Load Preferences
    const lp = a.nodes.find(x => x.name === 'Load Preferences');
    pruefe('Load Preferences: je Person, Vorlieben, nicht veraltet, hoechstens 5', lp && /category = 'preference'/.test(lp.parameters.query) && /owner_user_id = '\{\{ \$\('Merge Input'\)\.first\(\)\.json\.qualifiedUserId \}\}'/.test(lp.parameters.query) && /LIMIT 5/.test(lp.parameters.query) && lp.alwaysOutputData === true && lp.continueOnFail === true, lp);
    pruefe('Kette: Load Insights -> Load Preferences -> Build System Prompt', a.connections['Load Insights'].main[0][0].node === 'Load Preferences' && a.connections['Load Preferences'].main[0][0].node === 'Build System Prompt', [a.connections['Load Insights'], a.connections['Load Preferences']]);
  }

  console.log('--- Save Reminder (Factory) ---');
  {
    const CODE = code('workflows/reminder-factory.json', 'Save Reminder');
    async function sr(json) {
      const calls = [];
      const helpers = { async httpRequest(o) { calls.push({ method: o.method, url: o.url, body: o.body }); if (o.method === 'GET') return [{ id: 4, type: 'reminder', remind_at: '2026-09-30T07:00:00+00:00', message: 'Billing' }]; return [{ id: 99 }]; } };
      const fn = new AsyncFunction('$input', 'helpers', CODE + '\n//# sourceURL=save-reminder.js');
      const out = await fn({ first: () => ({ json }) }, helpers);
      return { out: out[0].json, calls };
    }
    let r = await sr({ time: '2026-09-30T09:00:00+02:00', message: 'Billing-Nummer aendern', type: 'reminder', action: '', userId: 'web:florian', chatId: 'teams:a:1bug', sessionId: 'teams:a:1bug' });
    pruefe('Einzelfelder: Erinnerung unter web:florian mit Teams-Sitzung als chat_id', r.calls[0].method === 'POST' && /reminders/.test(r.calls[0].url) && r.calls[0].body.user_id === 'web:florian' && r.calls[0].body.chat_id === 'teams:a:1bug' && r.calls[0].body.remind_at === '2026-09-30T09:00:00+02:00' && r.calls[0].body.message === 'Billing-Nummer aendern', r.calls[0]);
    pruefe('Antwort nennt den Zustellweg Teams-Chat', r.out.success === true && /Zustellung per Teams-Chat/.test(r.out.message) && r.out.id === 99, r.out);
    r = await sr({ query: JSON.stringify({ time: '2026-10-01T08:00:00+02:00', message: 'Alt', type: 'reminder' }), userId: 'web:hannah', chatId: 'web:hannah' });
    pruefe('JSON-String in query wird weiter verstanden; Webchat als Weg', r.calls[0].body.user_id === 'web:hannah' && r.calls[0].body.message === 'Alt' && /Webchat/.test(r.out.message), [r.calls[0], r.out]);
    r = await sr({ time: '2026-10-01T08:00:00+02:00', message: 'x', type: 'reminder', userId: 'telegram:1810565648', chatId: '' });
    pruefe('Telegram-Person ohne chatId: Nummer aus der Kennung, Weg Telegram', r.calls[0].body.chat_id === '1810565648' && /per Telegram/.test(r.out.message), [r.calls[0], r.out]);
    r = await sr({ time: '2026-10-01T08:00:00+02:00', message: 'x', type: 'reminder', userId: '', chatId: '' });
    pruefe('ohne Kennung: keine Speicherung, klare Meldung', r.calls.length === 0 && r.out.success === false && /Kennung der fragenden Person fehlt/.test(r.out.message), r);
    r = await sr({ action: 'list_reminders', userId: 'web:florian', chatId: 'teams:a:1bug' });
    pruefe('list_reminders filtert auf die Person', r.calls[0].method === 'GET' && /user_id=eq\.web%3Aflorian/.test(r.calls[0].url) && /\[4\]/.test(r.out.message), [r.calls[0].url, r.out]);
    r = await sr({ action: 'delete_reminder', target_id: '4', userId: 'web:florian', chatId: 'teams:a:1bug' });
    pruefe('target_id aus Einzelfeld kommt an', r.calls[0].method === 'DELETE' && /id=eq\.4/.test(r.calls[0].url), r.calls[0]);
    r = await sr({ type: 'recurring', name: 'Briefing', instruction: 'Fasse zusammen', schedule: '{"type":"daily","time":"08:00"}', userId: 'web:florian', chatId: 'teams:a:1bug', message: '' });
    pruefe('recurring: schedule als JSON-String wird gelesen, Zeile unter der Person', r.calls[0].method === 'POST' && /scheduled_actions/.test(r.calls[0].url) && r.calls[0].body.user_id === 'web:florian' && r.calls[0].body.chat_id === 'teams:a:1bug' && r.calls[0].body.schedule.type === 'daily' && /daily at 08:00/.test(r.out.message) && /Teams-Chat/.test(r.out.message), [r.calls[0], r.out]);
    pruefe('kein Betreiber-Platzhalter mehr im Code', !/TELEGRAM_CHAT_ID/.test(wf('workflows/reminder-factory.json').nodes.find(x => x.name === 'Save Reminder').parameters.jsCode));
  }

  console.log('--- Reminder Runner ---');
  {
    const RUN = 'workflows/reminder-runner.json';
    const CODE = code(RUN, 'Check Reminders');
    const rows = [
      { id: 4, type: 'reminder', chat_id: 'teams:a:1bug', user_id: 'web:florian', message: 'Billing' },
      { id: 5, type: 'task', chat_id: '1810565648', user_id: 'telegram:1810565648', message: 'Pruefe' },
      { id: 6, type: 'reminder', chat_id: '1810565648', user_id: 'telegram:1810565648', message: 'Hallo' },
      { id: 7, type: 'task', chat_id: 'web:hannah', user_id: 'web:hannah', message: 'Bericht' }
    ];
    const helpers = { async httpRequest() { return rows; } };
    const fn = new AsyncFunction('helpers', CODE);
    const out = (await fn(helpers)).map(i => i.json);
    pruefe('Zustellweg je Zeile: zustellung / agent / telegram / agent', out.map(o => o.zustellweg).join() === 'zustellung,agent,telegram,agent', out.map(o => o.zustellweg));
    pruefe('Text mit Wecker-Praefix, Sitzung nur fuer Nicht-Telegram', out[0].text === '⏰ Billing' && out[0].session_id === 'teams:a:1bug' && out[2].session_id === null && out[0].art === 'erinnerung', out[0]);
    pruefe('urspruengliche Felder bleiben (id, user_id, chat_id, message)', out[0].id === 4 && out[0].user_id === 'web:florian' && out[0].chat_id === 'teams:a:1bug' && out[0].message === 'Billing', out[0]);
    const r = wf(RUN);
    const sw = r.nodes.find(x => x.name === 'Switch Type');
    pruefe('Switch Type: drei Regeln nach zustellweg', sw.parameters.rules.values.map(v => v.outputKey).join() === 'telegram,zustellung,agent' && sw.parameters.rules.values.every(v => /zustellweg/.test(v.conditions.conditions[0].leftValue)), sw.parameters.rules.values.map(v => v.outputKey));
    const c = r.connections['Switch Type'].main;
    pruefe('Ausgaenge: Send Messages, Zustellen, Execute Agent', c[0][0].node === 'Send Messages' && c[1][0].node === 'Zustellen' && c[2][0].node === 'Execute Agent', c);
    pruefe('alle drei Zweige enden in Mark Done', ['Send Messages', 'Zustellen', 'Execute Agent'].every(k => r.connections[k].main[0][0].node === 'Mark Done'), r.connections);
    pruefe('Zustellen-Knoten zeigt auf REPLACE_ZUSTELLUNG_ID', r.nodes.find(x => x.name === 'Zustellen').parameters.workflowId.value === 'REPLACE_ZUSTELLUNG_ID');
    // Mark Done
    const MD = code(RUN, 'Mark Done');
    const patched = [];
    const h2 = { async httpRequest(o) { patched.push(o.url); return {}; } };
    const $ = (name) => ({ all: () => rows.map(x => ({ json: x })) });
    const fn2 = new AsyncFunction('helpers', '$', '$input', MD);
    const md = await fn2(h2, $, { all: () => [{ json: {} }] });
    pruefe('Mark Done markiert alle faelligen Zeilen genau einmal', patched.length === 4 && patched.every(u => /reminders\?id=eq\.\d+/.test(u)) && md.length === 4, patched);
  }

  console.log('--- Heartbeat ---');
  {
    const h = wf('workflows/heartbeat.json');
    pruefe('Send Telegram ersetzt durch Zustellen', !h.nodes.some(x => x.name === 'Send Telegram') && h.nodes.some(x => x.name === 'Zustellen'), h.nodes.map(x => x.name));
    pruefe('Should Notify true -> Zustellen, Update Action bleibt', h.connections['Should Notify'].main[0].some(x => x.node === 'Zustellen') && h.connections['Should Notify'].main[0].some(x => x.node === 'Update Action') && h.connections['Should Notify'].main[1][0].node === 'Update Action', h.connections['Should Notify']);
    pruefe('kein Telegram-Knoten mehr im Heartbeat', !h.nodes.some(x => x.type === 'n8n-nodes-base.telegram'));
  }

  console.log('\n' + (n - f) + ' von ' + n + ' Faellen bestanden');
  process.exit(f ? 1 : 0);
})();
