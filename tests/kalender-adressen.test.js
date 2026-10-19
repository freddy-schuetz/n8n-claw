// Runde 10b (19.10.2026): Adressen fuer Frei/Belegt (find_free_slots,
// colleague_schedule) und fremde Termine (colleague_events). Sonnet 5 schickt
// for_email gern als Liste; ueber das Textfeld kam sie als '["a@x", "b@y"]' an,
// das Zerlegen an Kommas liess Klammern und Anfuehrungszeichen stehen, und
// Microsoft wies jede Adresse als "not a valid SMTP address" ab (Sonja am
// 19.10.2026, sechs Versuche). Der ECHTE Skill-Code laeuft mit nachgebautem Graph.
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const wf = JSON.parse(fs.readFileSync(path.join(REPO, 'workflows/skills/microsoft-calendar.json'), 'utf8'));
const CODE = wf.sub.nodes.find(x => x.type === 'n8n-nodes-base.code').parameters.jsCode
  .replace(/\{\{SUPABASE_URL\}\}/g, 'http://stub.local').replace(/\{\{SUPABASE_SERVICE_KEY\}\}/g, 'k');
const CREDS = [
  { cred_key: 'tenant_id', cred_value: 't' }, { cred_key: 'client_id', cred_value: 'c' }, { cred_key: 'client_secret', cred_value: 's' },
  { cred_key: 'token_key', cred_value: 'tk' }, { cred_key: 'redirect_uri', cred_value: 'https://x/webhook/ms-oauth-callback' }, { cred_key: 'internal_domain', cred_value: '@salzburgerland.com' }];

async function run(input) {
  const anfragen = [];
  const helpers = {
    async httpRequest(o) {
      const url = String(o.url || '');
      if (url.includes('template_credentials')) return CREDS;
      if (url.includes('user_identity_map')) return [{ entra_key: 'entra:sonja' }];
      if (url.includes('rpc/get_user_token')) return [{ status: 'connected', access_token: 'TOKEN', expires_at: new Date(Date.now() + 3600e3).toISOString(), scopes: 'x' }];
      if (url.includes('/me/mailboxSettings')) return { timeZone: 'W. Europe Standard Time' };
      if (url.includes('tool_audit_log')) return '';
      if (url.endsWith('/me/calendar/getSchedule')) {
        const b = JSON.parse(o.body);
        anfragen.push(b.schedules);
        // Wie Graph: eine Adresse mit Satzzeichen ist keine gueltige SMTP-Adresse
        return { value: b.schedules.map(s => /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+$/.test(s)
          ? { scheduleId: s, availabilityView: '0000', scheduleItems: [] }
          : { scheduleId: s, error: { message: 'The email address provided is not a valid SMTP address.' } }) };
      }
      if (url.includes('/users/') && url.includes('/calendarView')) { anfragen.push([decodeURIComponent(url.split('/users/')[1].split('/')[0])]); return { value: [] }; }
      if (url.endsWith('/me')) return { userPrincipalName: 's.rogl@salzburgerland.com' };
      throw new Error('unerwarteter Aufruf ' + url);
    }
  };
  const fn = new AsyncFunction('$input', 'helpers', CODE + '\n//# sourceURL=microsoft-calendar.js');
  const out = await fn({ first: () => ({ json: Object.assign({ caller: 'web:sonja' }, input) }) }, helpers);
  return { out: out[0].json, anfragen };
}

let n = 0, f = 0;
function pruefe(name, ok, info) { n++; if (!ok) f++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + JSON.stringify(info).slice(0, 400))); }
const ZEIT = { start: '2026-11-02T08:00:00', end: '2026-11-02T10:00:00', duration_min: '60' };

(async () => {
  for (const [name, eingabe] of [
    ['Liste als Text (so kam sie am 19.10. an)', '["a.leitner@salzburgerland.com", "m.hettrich@salzburgerland.com", "s.rogl@salzburgerland.com"]'],
    ['echte Liste', ['a.leitner@salzburgerland.com', 'm.hettrich@salzburgerland.com', 's.rogl@salzburgerland.com']],
    ['Komma-Text wie bisher', 'a.leitner@salzburgerland.com, m.hettrich@salzburgerland.com,s.rogl@salzburgerland.com'],
    ['Namen mit Adresse', 'Alina Leitner <A.Leitner@SalzburgerLand.com>; Michael (m.hettrich@salzburgerland.com) s.rogl@salzburgerland.com']
  ]) {
    const r = await run(Object.assign({ action: 'find_free_slots', for_email: eingabe }, ZEIT));
    pruefe('find_free_slots, ' + name + ': saubere Adressen an Microsoft, freie Fenster', JSON.stringify(r.anfragen[0]) === '["a.leitner@salzburgerland.com","m.hettrich@salzburgerland.com","s.rogl@salzburgerland.com"]' && /freie Fenster/.test(r.out.result || ''), r);
  }
  let r = await run(Object.assign({ action: 'find_free_slots', for_email: '' }, ZEIT));
  pruefe('find_free_slots ohne Adresse: eigener Kalender wie bisher', JSON.stringify(r.anfragen[0]) === '["s.rogl@salzburgerland.com"]' && /freie Fenster/.test(r.out.result || ''), r);
  r = await run({ action: 'colleague_schedule', for_email: '["a.leitner@salzburgerland.com"]', start: '2026-11-02T00:00:00', end: '2026-11-03T00:00:00' });
  pruefe('colleague_schedule, Liste als Text: saubere Adresse', JSON.stringify(r.anfragen[0]) === '["a.leitner@salzburgerland.com"]' && !r.out.error, r);
  r = await run({ action: 'colleague_schedule', for_email: 'Alina' });
  pruefe('colleague_schedule ohne Adresse: klare Rueckfrage wie bisher', /for_email/.test(r.out.error || ''), r.out);
  r = await run({ action: 'colleague_events', for_email: '["a.leitner@salzburgerland.com"]' });
  pruefe('colleague_events, Liste als Text mit genau einer Adresse: geht', !(r.out.error && /genau eine/.test(r.out.error)) && JSON.stringify(r.anfragen[0]) === '["a.leitner@salzburgerland.com"]', r);
  r = await run({ action: 'colleague_events', for_email: '["a.leitner@salzburgerland.com", "m.hettrich@salzburgerland.com"]' });
  pruefe('colleague_events mit zwei Adressen: Rueckfrage "genau eine" wie bisher', /genau eine/.test(r.out.error || ''), r.out);

  console.log('\n' + (n - f) + ' von ' + n + ' bestanden');
  process.exit(f ? 1 : 0);
})();
