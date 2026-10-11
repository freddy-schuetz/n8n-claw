// Runde 8 (11.10.2026): Google Analytics 4 und Search Console, Anmeldung ueber
// ein Dienstkonto von SLT (dasselbe, das sie in Adverity nutzen).
//
// Der ECHTE Skill-Code laeuft hier mit gefaelschten HTTP-Aufrufen. Besonderheit
// gegenueber den anderen Tests: der JWT wird nicht nur auf Form geprueft,
// sondern mit einem echten RSA-Schluesselpaar signiert und wieder verifiziert.
// Wenn diese Tests gruen sind, ist bewiesen, dass die Signatur stimmt; offen
// bleibt allein, ob crypto.subtle im n8n-Code-Knoten erreichbar ist, und das
// sagt der Selbsttest auf dem Server.
//
// Aufruf: node tests/google-web.test.js
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const REPO = path.join(__dirname, '..');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const SA = {
  type: 'service_account',
  project_id: 'thermal-petal-436809-i6',
  client_email: 'adverity@thermal-petal-436809-i6.iam.gserviceaccount.com',
  private_key: privateKey,
  token_uri: 'https://oauth2.googleapis.com/token',
};

function code() {
  const wf = JSON.parse(fs.readFileSync(path.join(REPO, 'workflows/skills/google-web.json'), 'utf8'));
  const n = wf.sub.nodes.find((x) => x.type === 'n8n-nodes-base.code');
  return n.parameters.jsCode
    .replace(/\{\{SUPABASE_URL\}\}/g, 'http://stub.local')
    .replace(/\{\{SUPABASE_SERVICE_KEY\}\}/g, 'k');
}
const CODE = code();
function ohneKommentarGlobal() {
  return CODE.split(/\r?\n/).filter((zeile) => !zeile.trim().startsWith('//')).join('\n');
}

function jwtPruefen(body) {
  const m = String(body).match(/assertion=([^&]+)/);
  if (!m) throw new Error('kein assertion im Body');
  const jwt = decodeURIComponent(m[1]);
  const [kopf64, satz64, sig64] = jwt.split('.');
  const kopf = JSON.parse(Buffer.from(kopf64, 'base64url').toString('utf8'));
  const satz = JSON.parse(Buffer.from(satz64, 'base64url').toString('utf8'));
  const v = nodeCrypto.createVerify('RSA-SHA256');
  v.update(kopf64 + '.' + satz64);
  const gueltig = v.verify(publicKey, Buffer.from(sig64, 'base64url'));
  const grant = /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/.test(String(body));
  return { kopf, satz, gueltig, grant };
}

// Eine Buehne je Lauf: Aufrufe mitschreiben, Antworten steuern.
function buehne(opt) {
  opt = opt || {};
  const b = {
    aufrufe: [],
    koerper: [],
    jwt: null,
    tokenAufrufe: 0,
    speicher: opt.speicher === undefined ? null : opt.speicher,
    gespeichert: [],
  };
  const zugang = opt.zugang === undefined
    ? [
      { cred_key: 'service_account_json', cred_value: JSON.stringify(SA) },
      { cred_key: 'ga4_property_id', cred_value: '404505826' },
      { cred_key: 'gsc_site_url', cred_value: 'sc-domain:salzburgerland.com' },
    ]
    : opt.zugang;

  b.helpers = {
    async httpRequest(o) {
      const url = String(o.url || '');
      b.aufrufe.push({ url, method: o.method, body: o.body });
      if (o.body && typeof o.body === 'object') b.koerper.push(o.body);

      if (url.includes('template_credentials')) {
        if (opt.zugangFehler) throw new Error('DB weg');
        return zugang;
      }
      if (url.includes('project_memory') && (o.method || 'GET') === 'GET') {
        return b.speicher ? [{ content: JSON.stringify(b.speicher) }] : [];
      }
      if (url.includes('project_memory')) { b.gespeichert.push(o.body); return {}; }
      if (url.includes('oauth2.googleapis.com/token')) {
        b.tokenAufrufe++;
        b.jwt = jwtPruefen(o.body);
        if (opt.tokenFehler) throw opt.tokenFehler;
        return { access_token: 'AT-123', expires_in: 3600, token_type: 'Bearer' };
      }
      if (opt.google) return opt.google(url, o);
      throw new Error('unerwarteter Aufruf ' + url);
    },
  };
  return b;
}

async function lauf(input, opt) {
  const b = buehne(opt);
  const fn = new AsyncFunction('$input', 'helpers', CODE + '\n//# sourceURL=google-web');
  const out = await fn({ first: () => ({ json: Object.assign({ caller: 'web:mike' }, input) }) }, b.helpers);
  return { out: (out && out[0] && out[0].json) || {}, b };
}

let n = 0;
let f = 0;
function pruefe(name, ok, info) {
  n++;
  if (!ok) f++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + JSON.stringify(info).slice(0, 400)));
}

// ---- gefaelschte Google-Antworten ----
const GA4_ANTWORT = {
  dimensionHeaders: [{ name: 'pagePath' }],
  metricHeaders: [{ name: 'screenPageViews' }, { name: 'sessions' }],
  rows: [
    { dimensionValues: [{ value: '/winter' }], metricValues: [{ value: '12345' }, { value: '4567' }] },
    { dimensionValues: [{ value: '/sommer' }], metricValues: [{ value: '2345' }, { value: '890' }] },
  ],
  rowCount: 42,
};
const GA4_SUMMEN = {
  dimensionHeaders: [],
  metricHeaders: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'engagementRate' }, { name: 'averageSessionDuration' }],
  rows: [{ dimensionValues: [], metricValues: [{ value: '98765' }, { value: '54321' }, { value: '0.6234' }, { value: '95.4' }] }],
  rowCount: 1,
};
const GSC_ANTWORT = {
  rows: [
    { keys: ['salzburgerland'], clicks: 1234, impressions: 56789, ctr: 0.0217, position: 3.42 },
    { keys: ['wandern salzburg'], clicks: 321, impressions: 9876, ctr: 0.0325, position: 7.8 },
  ],
};
function googleStub(f) {
  return (url, o) => {
    if (f) {
      const r = f(url, o);
      if (r !== undefined) return r;
    }
    if (url.includes(':runReport')) return (o.body.dimensions || []).length ? GA4_ANTWORT : GA4_SUMMEN;
    if (url.includes(':runRealtimeReport')) {
      return { dimensionHeaders: [{ name: 'country' }], metricHeaders: [{ name: 'activeUsers' }], rows: [{ dimensionValues: [{ value: 'Austria' }], metricValues: [{ value: '17' }] }, { dimensionValues: [{ value: 'Germany' }], metricValues: [{ value: '8' }] }] };
    }
    if (url.includes('/metadata')) {
      return { metrics: [{ apiName: 'totalRevenue', uiName: 'Gesamtumsatz' }, { apiName: 'sessions', uiName: 'Sitzungen' }], dimensions: [{ apiName: 'pagePath', uiName: 'Seitenpfad' }] };
    }
    if (url.endsWith('/webmasters/v3/sites')) {
      return { siteEntry: [{ siteUrl: 'sc-domain:salzburgerland.com', permissionLevel: 'siteOwner' }, { siteUrl: 'https://www.salzburgerland.com/', permissionLevel: 'siteFullUser' }] };
    }
    if (url.includes('searchAnalytics/query')) return GSC_ANTWORT;
    if (url.includes('urlInspection')) {
      return { inspectionResult: { indexStatusResult: { coverageState: 'Submitted and indexed', lastCrawlTime: '2026-10-08T04:12:00Z', googleCanonical: 'https://www.salzburgerland.com/de/winter/', userCanonical: 'https://www.salzburgerland.com/de/winter/', robotsTxtState: 'ALLOWED', indexingState: 'INDEXING_ALLOWED' }, mobileUsabilityResult: { verdict: 'PASS' }, inspectionResultLink: 'https://search.google.com/search-console/inspect?x=1' } };
    }
    throw new Error('unerwartet ' + url);
  };
}
function httpFehler(status, meldung) {
  const e = new Error('Request failed with status code ' + status);
  e.httpCode = String(status);
  e.response = { statusCode: status, body: { error: { code: status, message: meldung || 'kaputt', status: 'PERMISSION_DENIED' } } };
  return e;
}

(async () => {
  console.log('--- Anmeldung: der JWT muss echt sein ---');
  let r = await lauf({ action: 'ga4_quick', preset: 'ueberblick' }, { google: googleStub() });
  pruefe('Token wurde geholt', r.b.tokenAufrufe === 1, r.b.aufrufe.map((a) => a.url));
  pruefe('JWT-Signatur verifiziert mit dem oeffentlichen Schluessel', r.b.jwt && r.b.jwt.gueltig === true, r.b.jwt && r.b.jwt.kopf);
  pruefe('Algorithmus RS256', r.b.jwt.kopf.alg === 'RS256' && r.b.jwt.kopf.typ === 'JWT', r.b.jwt.kopf);
  pruefe('iss ist die Dienstkonto-Adresse', r.b.jwt.satz.iss === SA.client_email, r.b.jwt.satz);
  pruefe('aud ist der Token-Endpunkt', r.b.jwt.satz.aud === 'https://oauth2.googleapis.com/token', r.b.jwt.satz);
  pruefe('Scopes: Analytics lesen und Search Console lesen', /analytics\.readonly/.test(r.b.jwt.satz.scope) && /webmasters\.readonly/.test(r.b.jwt.satz.scope), r.b.jwt.satz.scope);
  pruefe('Gueltigkeit hoechstens eine Stunde', r.b.jwt.satz.exp - r.b.jwt.satz.iat <= 3600 && r.b.jwt.satz.exp > r.b.jwt.satz.iat, r.b.jwt.satz);
  pruefe('grant_type ist jwt-bearer', r.b.jwt.grant === true, '');
  // Bewusst KEIN Zwischenspeicher: die Tabelle project_memory gibt es auf
  // dieser Instanz nicht. Ein Aufruf signiert selbst (rund 30 ms) und holt ein
  // frisches Token. Der frueher dafuer gedachte Schreibzugriff ist raus.
  pruefe('kein Schreibzugriff fuer einen Zwischenspeicher', r.b.gespeichert.length === 0, r.b.gespeichert);
  pruefe('Aufruf traegt das Bearer-Token', r.b.aufrufe.some((a) => a.url.includes('runReport')), r.b.aufrufe.map((a) => a.url));

  r = await lauf({ action: 'ga4_quick' }, { google: googleStub() });
  pruefe('je Aufruf genau ein Token, kein Lesen eines Zwischenspeichers',
    r.b.tokenAufrufe === 1 && !r.b.aufrufe.some((a) => a.url.includes('project_memory')), r.b.aufrufe.map((a) => a.url));

  console.log('--- Zugang fehlt: freundlich, nicht technisch ---');
  r = await lauf({ action: 'ga4_quick' }, { zugang: [] });
  pruefe('ohne Schluessel: Hinweis auf die Freigabe', /noch nicht eingerichtet/.test(r.out.error) && /Freigabe/.test(r.out.error), r.out);
  pruefe('ohne Schluessel: kein Google-Aufruf', r.b.tokenAufrufe === 0, '');
  r = await lauf({ action: 'ga4_quick' }, { zugang: [{ cred_key: 'service_account_json', cred_value: '{kaputt' }] });
  pruefe('kaputtes JSON wird benannt', /kein gueltiges JSON/.test(r.out.error), r.out);
  r = await lauf({ action: 'ga4_quick' }, { zugang: [{ cred_key: 'service_account_json', cred_value: JSON.stringify({ client_email: 'x@y' }) }] });
  pruefe('fehlender private_key wird benannt', /private_key/.test(r.out.error), r.out);

  console.log('--- Der private Schluessel darf nie in einer Meldung stehen ---');
  const geheim = SA.private_key.split('\n')[1].slice(0, 24);
  r = await lauf({ action: 'ga4_quick' }, { google: () => { throw httpFehler(500, 'irgendwas'); } });
  pruefe('Fehlertext enthaelt kein Schluesselmaterial', !String(JSON.stringify(r.out)).includes(geheim), r.out);
  r = await lauf({ action: 'ga4_quick' }, { tokenFehler: httpFehler(400, 'invalid_grant') });
  pruefe('Token-Fehler enthaelt kein Schluesselmaterial', !String(JSON.stringify(r.out)).includes(geheim), r.out);

  console.log('--- Zeitraeume in normaler Sprache ---');
  function bereich(out, b) { const k = b.koerper.find((x) => x.dateRanges); return k && k.dateRanges[0]; }
  const heute = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Vienna', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  r = await lauf({ action: 'ga4_quick', period: 'gestern' }, { google: googleStub() });
  let z = bereich(r.out, r.b);
  pruefe('gestern: ein Tag, nicht heute', z.startDate === z.endDate && z.endDate < heute, z);
  r = await lauf({ action: 'ga4_quick', period: 'letzte 7 Tage' }, { google: googleStub() });
  z = bereich(r.out, r.b);
  pruefe('letzte 7 Tage: Ende heute, Start sechs Tage davor', z.endDate === heute && (new Date(z.endDate) - new Date(z.startDate)) / 86400000 === 6, z);
  r = await lauf({ action: 'ga4_quick', period: '2026-09-01 bis 2026-09-30' }, { google: googleStub() });
  z = bereich(r.out, r.b);
  pruefe('zwei Daten werden uebernommen', z.startDate === '2026-09-01' && z.endDate === '2026-09-30', z);
  r = await lauf({ action: 'ga4_quick', period: '01.09.2026 bis 30.09.2026' }, { google: googleStub() });
  z = bereich(r.out, r.b);
  pruefe('deutsches Datumsformat', z.startDate === '2026-09-01' && z.endDate === '2026-09-30', z);
  r = await lauf({ action: 'ga4_quick', period: 'September 2025' }, { google: googleStub() });
  z = bereich(r.out, r.b);
  pruefe('Monatsname mit Jahr', z.startDate === '2025-09-01' && z.endDate === '2025-09-30', z);
  r = await lauf({ action: 'ga4_quick', period: 'letztes Jahr' }, { google: googleStub() });
  z = bereich(r.out, r.b);
  pruefe('letztes Jahr: ganzes Vorjahr', /^\d{4}-01-01$/.test(z.startDate) && /^\d{4}-12-31$/.test(z.endDate), z);
  r = await lauf({ action: 'ga4_quick', period: 'seit neulich' }, { google: googleStub() });
  pruefe('unverstaendlicher Zeitraum: Fehler mit Beispielen', /verstehe ich nicht/.test(r.out.error) && /letzte 7 Tage/.test(r.out.error), r.out);
  pruefe('und kein Google-Aufruf dabei', !r.b.aufrufe.some((a) => a.url.includes('runReport')), r.b.aufrufe.map((a) => a.url));
  r = await lauf({ action: 'ga4_quick' }, { google: googleStub() });
  z = bereich(r.out, r.b);
  pruefe('Vorgabe ohne Angabe: 28 Tage', (new Date(z.endDate) - new Date(z.startDate)) / 86400000 === 27, z);

  console.log('--- Deutsche Metriken und Dimensionen ---');
  r = await lauf({ action: 'ga4_report', metrics: 'Sitzungen, Nutzer', dimensions: 'Seite' }, { google: googleStub() });
  let k = r.b.koerper.find((x) => x.metrics);
  pruefe('Sitzungen und Nutzer werden uebersetzt', JSON.stringify(k.metrics) === JSON.stringify([{ name: 'sessions' }, { name: 'activeUsers' }]), k.metrics);
  pruefe('Seite wird pagePath', JSON.stringify(k.dimensions) === JSON.stringify([{ name: 'pagePath' }]), k.dimensions);
  r = await lauf({ action: 'ga4_report', metrics: 'screenPageViews', dimensions: 'quelle/medium' }, { google: googleStub() });
  k = r.b.koerper.find((x) => x.metrics);
  pruefe('echter API-Name wird durchgelassen', k.metrics[0].name === 'screenPageViews', k.metrics);
  pruefe('quelle/medium wird sessionSourceMedium', k.dimensions[0].name === 'sessionSourceMedium', k.dimensions);
  r = await lauf({ action: 'ga4_report', metrics: 'Klickzahl' }, { google: googleStub() });
  pruefe('unbekannte Metrik: Fehler mit Vorschlaegen und Hinweis auf ga4_fields', /kenne ich nicht/.test(r.out.error) && /ga4_fields/.test(r.out.error), r.out);

  console.log('--- Voreinstellungen ---');
  r = await lauf({ action: 'ga4_quick', preset: 'top_seiten' }, { google: googleStub() });
  k = r.b.koerper.find((x) => x.metrics);
  pruefe('top_seiten: pagePath und Seitenaufrufe', k.dimensions[0].name === 'pagePath' && k.metrics[0].name === 'screenPageViews', k);
  pruefe('top_seiten: absteigend nach Aufrufen sortiert', k.orderBys && k.orderBys[0].metric.metricName === 'screenPageViews' && k.orderBys[0].desc === true, k.orderBys);
  pruefe('top_seiten: Tabelle mit Zahlen in deutscher Schreibweise', /12\.345/.test(r.out.result), r.out.result);
  r = await lauf({ action: 'ga4_quick', preset: 'verlauf' }, { google: googleStub() });
  k = r.b.koerper.find((x) => x.metrics);
  pruefe('verlauf: nach Datum aufsteigend', k.orderBys[0].dimension.dimensionName === 'date' && k.orderBys[0].desc === false, k.orderBys);
  r = await lauf({ action: 'ga4_quick', preset: 'ueberblick' }, { google: googleStub() });
  pruefe('ueberblick: keine Tabelle, sondern Kennzahlen', /sitzungen: 98\.765/i.test(r.out.result) && !/\|/.test(r.out.result), r.out.result);
  pruefe('ueberblick: Rate als Prozent', /62,3 %/.test(r.out.result), r.out.result);
  pruefe('ueberblick: Dauer als Minuten und Sekunden', /1 min 35 s/.test(r.out.result), r.out.result);
  r = await lauf({ action: 'ga4_quick', preset: 'gibtsnicht' }, { google: googleStub() });
  pruefe('unbekannte Voreinstellung: Liste der moeglichen', /top_seiten/.test(r.out.error) && /quellen/.test(r.out.error), r.out);

  console.log('--- Filter ---');
  r = await lauf({ action: 'ga4_report', dimensions: 'seite', filter: 'seite enthaelt /winter' }, { google: googleStub() });
  k = r.b.koerper.find((x) => x.dimensionFilter);
  pruefe('enthaelt wird CONTAINS auf pagePath', k.dimensionFilter.filter.fieldName === 'pagePath' && k.dimensionFilter.filter.stringFilter.matchType === 'CONTAINS' && k.dimensionFilter.filter.stringFilter.value === '/winter', k.dimensionFilter);
  r = await lauf({ action: 'ga4_report', dimensions: 'land', filter: 'land = Oesterreich' }, { google: googleStub() });
  k = r.b.koerper.find((x) => x.dimensionFilter);
  pruefe('Gleichheitsfilter wird EXACT auf country', k.dimensionFilter.filter.fieldName === 'country' && k.dimensionFilter.filter.stringFilter.matchType === 'EXACT', k.dimensionFilter);
  r = await lauf({ action: 'ga4_report', dimensions: 'land', filter: 'land ist nicht Deutschland' }, { google: googleStub() });
  k = r.b.koerper.find((x) => x.dimensionFilter);
  pruefe('Verneinung wird notExpression', !!k.dimensionFilter.notExpression, k.dimensionFilter);
  r = await lauf({ action: 'ga4_report', filter: 'irgendwas seltsam' }, { google: googleStub() });
  pruefe('unverstaendlicher Filter: Muster werden gezeigt', /Muster/.test(r.out.error) && /enthaelt/.test(r.out.error), r.out);

  console.log('--- Search Console ---');
  r = await lauf({ action: 'gsc_search' }, { google: googleStub() });
  const gsc = r.b.aufrufe.find((a) => a.url.includes('searchAnalytics/query'));
  pruefe('Domain-Property wird kodiert uebergeben', gsc.url.includes('sc-domain%3Asalzburgerland.com'), gsc.url);
  pruefe('Vorgabe-Dimension ist query', JSON.stringify(gsc.body.dimensions) === JSON.stringify(['query']), gsc.body);
  const dreiTage = new Date(new Date(heute + 'T00:00:00Z') - 3 * 86400000).toISOString().slice(0, 10);
  pruefe('Ende liegt drei Tage zurueck (Datenverzug)', gsc.body.endDate === dreiTage, { ende: gsc.body.endDate, erwartet: dreiTage });
  pruefe('Antwort nennt den Verzug', /mit Verzug endgueltig frei/.test(r.out.result), r.out.result);
  pruefe('dataState final, nicht fresh', gsc.body.dataState === 'final', gsc.body);
  pruefe('Datenschutzhinweis bei Suchbegriffen', /aus Datenschutzgruenden weg/.test(r.out.result), r.out.result);
  r = await lauf({ action: 'gsc_search', dimensions: 'land' }, { google: googleStub() });
  pruefe('ohne Suchbegriff-Dimension kein Datenschutzhinweis', !/Datenschutzgruenden/.test(r.out.result), r.out.result);
  pruefe('Tabelle mit Klicks, Impressionen, CTR, Position', /Klicks/.test(r.out.result) && /1\.234/.test(r.out.result) && /3,4/.test(r.out.result), r.out.result);
  r = await lauf({ action: 'gsc_search', dimensions: 'Suchbegriff, Seite', limit: '5' }, { google: googleStub() });
  const gsc2 = r.b.aufrufe.find((a) => a.url.includes('searchAnalytics/query'));
  pruefe('mehrere Dimensionen uebersetzt', JSON.stringify(gsc2.body.dimensions) === JSON.stringify(['query', 'page']), gsc2.body);
  pruefe('rowLimit kommt aus limit', gsc2.body.rowLimit === 5, gsc2.body);
  r = await lauf({ action: 'gsc_search', filter: 'seite enthaelt /winter' }, { google: googleStub() });
  const gsc3 = r.b.aufrufe.find((a) => a.url.includes('searchAnalytics/query'));
  pruefe('Filter wird dimensionFilterGroups', gsc3.body.dimensionFilterGroups[0].filters[0].dimension === 'page' && gsc3.body.dimensionFilterGroups[0].filters[0].operator === 'contains', gsc3.body);
  r = await lauf({ action: 'gsc_search' }, { google: () => ({ rows: [] }) });
  pruefe('keine Zeilen: erklaerender Satz statt leerer Tabelle', /keine Zeilen/.test(r.out.result), r.out);

  console.log('--- URL pruefen ---');
  r = await lauf({ action: 'gsc_inspect', url: 'https://www.salzburgerland.com/de/winter/' }, { google: googleStub() });
  pruefe('Indexstatus wird genannt', /Submitted and indexed/.test(r.out.result), r.out);
  pruefe('letzte Erfassung lesbar als Datum', /08\.10\.2026/.test(r.out.result), r.out.result);
  pruefe('mobile Nutzbarkeit dabei', /Mobil nutzbar: PASS/.test(r.out.result), r.out.result);
  r = await lauf({ action: 'gsc_inspect' }, { google: googleStub() });
  pruefe('ohne URL: Rueckfrage, kein Aufruf', /Welche URL/.test(r.out.error) && !r.b.aufrufe.some((a) => a.url.includes('urlInspection')), r.out);
  r = await lauf({ action: 'gsc_inspect', url: 'salzburgerland.com' }, { google: googleStub() });
  pruefe('ohne Schema: Hinweis auf https', /https:\/\//.test(r.out.error), r.out);

  console.log('--- Echtzeit und Feldsuche ---');
  r = await lauf({ action: 'ga4_realtime' }, { google: googleStub() });
  pruefe('Echtzeit: Summe und Tabelle', /25 aktive Nutzer/.test(r.out.result) && /Austria/.test(r.out.result), r.out.result);
  r = await lauf({ action: 'ga4_realtime' }, { google: (url) => (url.includes('Realtime') ? { rows: [] } : undefined) });
  pruefe('Echtzeit ohne Besuch: klarer Satz', /niemand/.test(r.out.result), r.out);
  r = await lauf({ action: 'ga4_fields', query: 'Umsatz' }, { google: googleStub() });
  pruefe('Feldsuche findet totalRevenue', /totalRevenue/.test(r.out.result) && !/pagePath/.test(r.out.result), r.out.result);

  console.log('--- Fehler von Google werden erklaert ---');
  r = await lauf({ action: 'ga4_quick' }, { google: () => { throw httpFehler(403, 'User does not have sufficient permissions for this property.'); } });
  pruefe('403: Freigabe oder API, mit Googles Wortlaut', /nicht freigegeben|verweigert/.test(r.out.error) && /API/.test(r.out.error) && /sufficient permissions/.test(r.out.error), r.out);
  r = await lauf({ action: 'ga4_quick' }, { google: () => { throw httpFehler(429, 'Quota exceeded'); } });
  pruefe('429: Kontingent, bitte spaeter', /Kontingent/.test(r.out.error), r.out);
  r = await lauf({ action: 'ga4_quick' }, { google: () => { throw httpFehler(404, 'Property not found'); } });
  pruefe('404: Property nicht gefunden', /findet diese Property nicht/.test(r.out.error), r.out);

  console.log('--- Property und Aktionen ---');
  r = await lauf({ action: 'ga4_quick' }, { google: googleStub() });
  pruefe('hinterlegte Property wird benutzt', r.b.aufrufe.some((a) => a.url.includes('properties/404505826')), r.b.aufrufe.map((a) => a.url));
  r = await lauf({ action: 'ga4_quick', property_id: '999' }, { google: googleStub() });
  pruefe('mitgegebene Property gewinnt', r.b.aufrufe.some((a) => a.url.includes('properties/999')), r.b.aufrufe.map((a) => a.url));
  r = await lauf({ action: 'ga4_quick' }, { google: googleStub(), zugang: [{ cred_key: 'service_account_json', cred_value: JSON.stringify(SA) }] });
  pruefe('ohne hinterlegte Property: klarer Hinweis', /keine GA4-Property/.test(r.out.error), r.out);
  r = await lauf({ action: 'was_auch_immer' }, { google: googleStub() });
  pruefe('unbekannte Aktion: Liste der Aktionen', /ga4_report/.test(r.out.error) && /gsc_search/.test(r.out.error), r.out);

  console.log('--- Korrekturen aus der API-Recherche ---');
  r = await lauf({ action: 'ga4_report', metrics: 'conversions' }, { google: googleStub() });
  k = r.b.koerper.find((x) => x.metrics);
  pruefe('conversions wird keyEvents (seit 2024 umbenannt)', k.metrics[0].name === 'keyEvents', k.metrics);
  r = await lauf({ action: 'ga4_realtime', dimensions: 'seite' }, { google: googleStub() });
  let rt = r.b.koerper.find((x) => x.dimensions && !x.dateRanges);
  pruefe('Echtzeit: seite wird unifiedScreenName', rt.dimensions[0].name === 'unifiedScreenName', rt);
  r = await lauf({ action: 'ga4_realtime', dimensions: 'quelle' }, { google: googleStub() });
  pruefe('Echtzeit lehnt unerlaubte Dimension ab, statt 400 zu kassieren', /Echtzeit-Dimension/.test(r.out.error || ''), r.out);
  r = await lauf({ action: 'ga4_quick', preset: 'top_seiten' }, {
    google: (url, o) => (url.includes(':runReport') ? Object.assign({}, GA4_ANTWORT, { metadata: { dataLossFromOtherRow: true, subjectToThresholding: true } }) : undefined),
  });
  pruefe('Sammelzeile (other) wird gemeldet', /other/.test(r.out.result), r.out.result);
  pruefe('Datenschutzschwelle wird gemeldet', /Datenschutzgruenden/.test(r.out.result), r.out.result);
  r = await lauf({ action: 'ga4_quick', period: 'gestern' }, { google: googleStub() });
  pruefe('GA4 nennt die Unfertigkeit der letzten Tage', /koennen sich noch aendern/.test(r.out.result), r.out.result);
  r = await lauf({ action: 'ga4_quick', period: 'letzter Monat' }, { google: googleStub() });
  pruefe('und bei abgeschlossenen Zeitraeumen nicht', !/koennen sich noch aendern/.test(r.out.result), r.out.result);

  console.log('--- Search Console: Werte, Kappung, Ausschluss ---');
  r = await lauf({ action: 'gsc_search', dimensions: 'land', filter: 'land = Oesterreich' }, { google: googleStub() });
  let gf = r.b.aufrufe.find((a) => a.url.includes('searchAnalytics')).body.dimensionFilterGroups[0];
  pruefe('Oesterreich wird zu aut', gf.filters[0].expression === 'aut', gf);
  pruefe('groupType and wird mitgegeben', gf.groupType === 'and', gf);
  r = await lauf({ action: 'gsc_search', dimensions: 'geraet', filter: 'geraet = Handy' }, { google: googleStub() });
  gf = r.b.aufrufe.find((a) => a.url.includes('searchAnalytics')).body.dimensionFilterGroups[0];
  pruefe('Handy wird zu MOBILE', gf.filters[0].expression === 'MOBILE', gf);
  r = await lauf({ action: 'gsc_search', period: 'heute' }, { google: googleStub() });
  pruefe('heute: erklaert statt leer zu antworten', /noch keine endgueltigen Zahlen/.test(r.out.error || ''), r.out);
  // Relative Zeitraeume enden von sich aus am letzten endgueltigen Tag; gekappt
  // wird, wer ein ausdrueckliches Enddatum nennt, das zu jung ist.
  r = await lauf({ action: 'gsc_search', period: '2026-10-01 bis ' + heute }, { google: googleStub() });
  pruefe('ausdrueckliches Enddatum wird gekappt und das gesagt', /gekappt/.test(r.out.result || r.out.error || ''), r.out);
  r = await lauf({ action: 'gsc_search', period: 'letzte 2 Tage' }, { google: googleStub() });
  pruefe('relativer Zeitraum endet ohne Kappung am letzten endgueltigen Tag', !/gekappt/.test(r.out.result || ''), r.out);
  r = await lauf({ action: 'gsc_search', dimensions: 'darstellung, seite' }, { google: googleStub() });
  pruefe('searchAppearance nur allein', /nur allein/.test(r.out.error || ''), r.out);

  console.log('--- Die Signatur stammt aus eigener Rechnung, nicht aus crypto ---');
  r = await lauf({ action: 'ga4_quick' }, { google: googleStub() });
  const teileJwt = (r.b.jwt && r.b.jwt.gueltig);
  pruefe('selbst gerechnete RS256-Signatur ist gueltig', teileJwt === true, r.b.jwt);
  const [k1, s1, g1] = (() => {
    const m = String(r.b.aufrufe.find((a) => a.url.includes('oauth2')).body).match(/assertion=([^&]+)/);
    return decodeURIComponent(m[1]).split('.');
  })();
  const nodeSig = nodeCrypto.createSign('RSA-SHA256').update(k1 + '.' + s1).sign(SA.private_key).toString('base64url');
  pruefe('und byteweise identisch mit node-crypto', g1 === nodeSig, { meine: g1.slice(0, 32), node: nodeSig.slice(0, 32) });
  // Kommentare erklaeren, warum es ohne crypto geht; der ausgefuehrte Code
  // darf es nicht anfassen, sonst stirbt er im n8n-Knoten.
  const ohneKommentar = CODE.split('\n').filter((zeile) => !zeile.trim().startsWith('//')).join('\n');
  pruefe('kein require und kein crypto im ausgefuehrten Code',
    !/require\s*\(/.test(ohneKommentar) && !/crypto\./.test(ohneKommentar),
    (ohneKommentar.match(/(require\s*\([^)]*\)|crypto\.[a-z]+)/g) || []).slice(0, 3));

  // ------------------------------------------------------------------
  // Ab hier: ein Fall je bestaetigtem Befund der adversarialen Pruefung
  // vom 11.10.2026 (fuenf Pruefer, 44 Befunde, 14 geprueft, alle 14 echt).
  // ------------------------------------------------------------------
  console.log('--- [P] Search Console kennt kein "beginnt mit" ---');
  r = await lauf({ action: 'gsc_search', dimensions: 'seite', filter: 'seite beginnt mit /winter' }, { google: googleStub() });
  let gq = r.b.aufrufe.find((a) => a.url.includes('searchAnalytics')).body.dimensionFilterGroups[0].filters[0];
  pruefe('beginnt mit wird includingRegex mit Anker', gq.operator === 'includingRegex' && gq.expression === '^/winter', gq);
  pruefe('und die Kopfzeile nennt den echten Operator', /includingRegex \^\/winter/.test(r.out.result), r.out.result);
  r = await lauf({ action: 'gsc_search', dimensions: 'seite', filter: 'seite endet mit .html' }, { google: googleStub() });
  gq = r.b.aufrufe.find((a) => a.url.includes('searchAnalytics')).body.dimensionFilterGroups[0].filters[0];
  pruefe('endet mit wird Regex mit Dollar und maskiertem Punkt', gq.expression === '\\.html$', gq);
  r = await lauf({ action: 'gsc_search', dimensions: 'seite', filter: 'seite = /winter/' }, { google: googleStub() });
  gq = r.b.aufrufe.find((a) => a.url.includes('searchAnalytics')).body.dimensionFilterGroups[0].filters[0];
  pruefe('Gleichheit bleibt equals', gq.operator === 'equals' && gq.expression === '/winter/', gq);

  console.log('--- [P] Zeitreihen zeigen den ganzen Zeitraum ---');
  function tageStub(tage) {
    return (url, o) => {
      if (!url.includes(':runReport')) return undefined;
      const n = Number(o.body.limit);
      const alle = [];
      for (let i = 0; i < tage; i++) {
        const d = new Date(Date.parse(o.body.dateRanges[0].startDate) + i * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
        alle.push({ dimensionValues: [{ value: d }], metricValues: [{ value: String(100 + i) }, { value: String(50 + i) }] });
      }
      const sortiert = o.body.orderBys && o.body.orderBys[0].desc ? alle.slice().reverse() : alle;
      return { dimensionHeaders: [{ name: 'date' }], metricHeaders: [{ name: 'sessions' }, { name: 'activeUsers' }], rows: sortiert.slice(0, n), rowCount: tage };
    };
  }
  r = await lauf({ action: 'ga4_quick', preset: 'verlauf' }, { google: tageStub(28) });
  k = r.b.koerper.find((x) => x.metrics);
  pruefe('verlauf fragt so viele Zeilen wie Tage', Number(k.limit) === 28, k.limit);
  pruefe('und zeigt den juengsten Tag', (r.out.result.match(/\n/g) || []).length >= 28 && /11\.10\.2026/.test(r.out.result), r.out.result.slice(-200));
  r = await lauf({ action: 'ga4_report', dimensions: 'datum', period: 'letzte 7 Tage' }, { google: tageStub(7) });
  k = r.b.koerper.find((x) => x.metrics);
  pruefe('auch der freie Bericht mit Datum nimmt die Tageszahl', Number(k.limit) === 7, k.limit);
  r = await lauf({ action: 'ga4_report', dimensions: 'datum', period: 'letzte 7 Tage', limit: '3' }, { google: tageStub(7) });
  k = r.b.koerper.find((x) => x.metrics);
  pruefe('ein ausdruecklich genanntes limit gewinnt', Number(k.limit) === 3, k.limit);
  pruefe('und dann kein Hinweis auf die juengsten Tage', !/koennen sich noch aendern/.test(r.out.result), r.out.result);
  r = await lauf({ action: 'gsc_search', dimensions: 'datum', period: 'letzte 14 Tage' }, {
    google: (url, o) => {
      if (!url.includes('searchAnalytics')) return undefined;
      // Die Search Console liefert nach Klicks absteigend, nicht nach Datum.
      return { rows: [
        { keys: ['2026-10-02'], clicks: 90, impressions: 900, ctr: 0.1, position: 3 },
        { keys: ['2026-09-28'], clicks: 50, impressions: 500, ctr: 0.1, position: 4 },
        { keys: ['2026-10-05'], clicks: 10, impressions: 100, ctr: 0.1, position: 5 },
      ] };
    },
  });
  const gsc4 = r.b.aufrufe.find((a) => a.url.includes('searchAnalytics'));
  pruefe('GSC-Zeitreihe fragt so viele Zeilen wie Tage', gsc4.body.rowLimit === 14, gsc4.body);
  pruefe('und sortiert die Antwort nach Datum', r.out.result.indexOf('28.09') < r.out.result.indexOf('02.10') && r.out.result.indexOf('02.10') < r.out.result.indexOf('05.10'), r.out.result);

  console.log('--- [P] Sortierfeld ---');
  r = await lauf({ action: 'ga4_report', metrics: 'sitzungen', dimensions: 'seite', order_by: 'umsatz' }, { google: googleStub() });
  k = r.b.koerper.find((x) => x.metrics);
  pruefe('Metrik aus order_by wird mitabgefragt, nicht als Dimension gesendet',
    k.metrics.some((m) => m.name === 'totalRevenue') && k.orderBys[0].metric && k.orderBys[0].metric.metricName === 'totalRevenue', k);
  r = await lauf({ action: 'ga4_report', metrics: 'sitzungen', dimensions: 'seite', order_by: 'land' }, { google: googleStub() });
  pruefe('Dimension, die nicht abgefragt wird, bringt eine klare Meldung', /nur sortieren, wenn/.test(r.out.error || ''), r.out);

  console.log('--- [P] GA4 erwartet englische Werte ---');
  r = await lauf({ action: 'ga4_report', dimensions: 'land', filter: 'land = Oesterreich' }, { google: googleStub() });
  k = r.b.koerper.find((x) => x.dimensionFilter);
  pruefe('Oesterreich wird Austria', k.dimensionFilter.filter.stringFilter.value === 'Austria', k.dimensionFilter);
  r = await lauf({ action: 'ga4_report', dimensions: 'stadt', filter: 'stadt = Wien' }, { google: googleStub() });
  k = r.b.koerper.find((x) => x.dimensionFilter);
  pruefe('Wien wird Vienna', k.dimensionFilter.filter.stringFilter.value === 'Vienna', k.dimensionFilter);
  r = await lauf({ action: 'ga4_report', dimensions: 'geraet', filter: 'geraet = Handy' }, { google: googleStub() });
  k = r.b.koerper.find((x) => x.dimensionFilter);
  pruefe('Handy wird mobile, kleingeschrieben', k.dimensionFilter.filter.stringFilter.value === 'mobile', k.dimensionFilter);

  console.log('--- [P] Filter trennen an der richtigen Stelle ---');
  r = await lauf({ action: 'ga4_report', dimensions: 'ereignis', filter: 'ereignis = view_item' }, { google: googleStub() });
  k = r.b.koerper.find((x) => x.dimensionFilter);
  pruefe('das is in ereignis zerschneidet nichts mehr',
    k && k.dimensionFilter.filter.fieldName === 'eventName' && k.dimensionFilter.filter.stringFilter.value === 'view_item', r.out);
  r = await lauf({ action: 'gsc_search', filter: 'suchbegriff = wie wird das wetter' }, { google: googleStub() });
  gq = r.b.aufrufe.find((a) => a.url.includes('searchAnalytics')).body.dimensionFilterGroups[0].filters[0];
  pruefe('ein wie im Wert trennt nicht mehr', gq.dimension === 'query' && gq.expression === 'wie wird das wetter', gq);
  r = await lauf({ action: 'gsc_search', dimensions: 'seite', filter: 'seite enthaelt /a=b' }, { google: googleStub() });
  gq = r.b.aufrufe.find((a) => a.url.includes('searchAnalytics')).body.dimensionFilterGroups[0].filters[0];
  pruefe('ein Gleichheitszeichen im Wert trennt nicht mehr', gq.operator === 'contains' && gq.expression === '/a=b', gq);

  console.log('--- [P] Echtzeit nennt die echte Gesamtzahl ---');
  r = await lauf({ action: 'ga4_realtime' }, {
    google: (url, o) => (url.includes('Realtime') ? {
      dimensionHeaders: [{ name: 'country' }], metricHeaders: [{ name: 'activeUsers' }],
      rows: Array.from({ length: 20 }, (_, i) => ({ dimensionValues: [{ value: 'Land' + i }], metricValues: [{ value: '40' }] })),
      totals: [{ metricValues: [{ value: '950' }] }], rowCount: 25,
    } : undefined),
  });
  pruefe('Gesamtzahl kommt von Google (950), nicht aus den 20 Zeilen (800)', /950 aktive Nutzer/.test(r.out.result), r.out.result.slice(0, 120));
  pruefe('und die Kappung wird gesagt', /ersten 20 Zeilen/.test(r.out.result), r.out.result.slice(0, 160));
  k = r.b.koerper.find((x) => x.metricAggregations);
  pruefe('TOTAL wird angefordert', k && k.metricAggregations[0] === 'TOTAL', k);

  console.log('--- [P] Kein Zwischenspeicher auf einer Tabelle, die es nicht gibt ---');
  r = await lauf({ action: 'ga4_quick' }, { google: googleStub() });
  pruefe('project_memory wird nicht mehr angefasst', !r.b.aufrufe.some((a) => a.url.includes('project_memory')), r.b.aufrufe.map((a) => a.url));
  pruefe('kein project_memory im Code', !/project_memory/.test(ohneKommentarGlobal()), '');

  console.log('--- [P] Die Property bestimmt die Konfiguration, nicht das Modell ---');
  const bundle = JSON.parse(fs.readFileSync(path.join(REPO, 'workflows/skills/google-web.json'), 'utf8'));
  const freiSetzbar = bundle.server.nodes
    .filter((n) => n.type.endsWith('toolWorkflow'))
    .flatMap((n) => Object.entries(n.parameters.workflowInputs.value)
      .filter(([f, v]) => (f === 'property_id' || f === 'site_url') && typeof v === 'string' && v.startsWith('={{'))
      .map(([f]) => n.name + '.' + f));
  pruefe('kein Werkzeug laesst das Modell die Property setzen', freiSetzbar.length === 0, freiSetzbar);
  const deklariert = bundle.server.nodes
    .filter((n) => n.type.endsWith('toolWorkflow'))
    .every((n) => {
      const v = n.parameters.workflowInputs.value;
      const sch = n.parameters.workflowInputs.schema.map((x) => x.id);
      return Object.keys(v).every((f) => sch.includes(f));
    });
  pruefe('jedes gesetzte Feld steht auch im Schema', deklariert, '');

  console.log('--- [P] Kleinere Befunde derselben Pruefung ---');
  r = await lauf({ action: 'gsc_search', search_type: 'googleNews' }, { google: googleStub() });
  let gs = r.b.aufrufe.find((a) => a.url.includes('searchAnalytics'));
  pruefe('googleNews behaelt die genaue Schreibweise', gs.body.type === 'googleNews', gs.body);
  r = await lauf({ action: 'gsc_search', search_type: 'Bilder' }, { google: googleStub() });
  gs = r.b.aufrufe.find((a) => a.url.includes('searchAnalytics'));
  pruefe('deutsches Bilder wird image', gs.body.type === 'image', gs.body);
  r = await lauf({ action: 'gsc_search', search_type: 'quatsch' }, { google: googleStub() });
  pruefe('unbekannte Suchart: Liste statt 400', /Moeglich sind: web, image/.test(r.out.error || ''), r.out);
  r = await lauf({ action: 'ga4_quick', period: '2026-02-31' }, { google: googleStub() });
  pruefe('den 31. Februar gibt es nicht und das sagt der Skill', /gibt es nicht/.test(r.out.error || ''), r.out);
  r = await lauf({ action: 'ga4_quick', period: '2026-09-30 bis 2026-09-01' }, { google: googleStub() });
  pruefe('verdrehter Zeitraum wird benannt', /beginnt nach seinem Ende/.test(r.out.error || ''), r.out);
  r = await lauf({ action: 'ga4_fields', query: 'x' }, { google: googleStub(), zugang: [{ cred_key: 'service_account_json', cred_value: JSON.stringify(SA) }] });
  pruefe('ga4_fields ohne Property: klare Meldung statt kaputter URL', /keine GA4-Property/.test(r.out.error || ''), r.out);
  r = await lauf({ action: 'gsc_inspect', url: 'https://x.at/' }, { google: googleStub(), zugang: [{ cred_key: 'service_account_json', cred_value: JSON.stringify(SA) }] });
  pruefe('gsc_inspect ohne Property: klare Meldung statt leerem siteUrl', /keine Search-Console-Property/.test(r.out.error || ''), r.out);
  r = await lauf({ action: 'ga4_report', metrics: 'conversions', dimensions: 'seite' }, {
    google: (url, o) => (url.includes(':runReport') ? { dimensionHeaders: [{ name: 'pagePath' }], metricHeaders: [{ name: 'keyEvents' }], rows: [{ dimensionValues: [{ value: '/a' }], metricValues: [{ value: '5' }] }], rowCount: 1 } : undefined),
  });
  pruefe('die Spalte heisst nicht mehr conversions', /wichtige Ereignisse/.test(r.out.result) && !/conversions/.test(r.out.result), r.out.result);

  console.log('--- [P] SHA-256 fuer jede Laenge, damit der Kommentar stimmt ---');
  (() => {
    // Die Signaturrechnung des Skills steckt im jsCode. Hier wird sie direkt
    // ausgeschnitten und gegen node-crypto gestellt, fuer jede Laenge 0 bis 200.
    const teil = CODE.slice(CODE.indexOf('const SHA_K ='), CODE.indexOf('function jwtSignieren'));
    const fn = new Function(teil + ' return { sha256, rs256 };');
    const { sha256, rs256 } = fn();
    let schlecht = [];
    for (let L = 0; L <= 200; L++) {
      const t = 'a'.repeat(L);
      if (Buffer.from(sha256(new TextEncoder().encode(t))).toString('hex') !== nodeCrypto.createHash('sha256').update(t).digest('hex')) schlecht.push(L);
    }
    pruefe('sha256 stimmt fuer alle Laengen 0 bis 200', schlecht.length === 0, schlecht.slice(0, 10));
    const der = Buffer.from(SA.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
    const text = 'eyJhIjoxfQ.eyJiIjoyfQ';
    const meine = Buffer.from(rs256(der, new TextEncoder().encode(text)));
    const node = nodeCrypto.createSign('RSA-SHA256').update(text).sign(SA.private_key);
    pruefe('rs256 ist byteweise die Signatur von node-crypto', meine.equals(node), { meine: meine.toString('hex').slice(0, 24), node: node.toString('hex').slice(0, 24) });
  })();

  console.log('--- Googles Begruendung ueberlebt jede Fehlerform ---');
  for (const [name, bauen] of [
    ['e.response.body', (m) => { const e = new Error('x'); e.httpCode = '400'; e.response = { statusCode: 400, body: { error: 'invalid_grant', error_description: m } }; return e; }],
    ['e.response.data', (m) => { const e = new Error('x'); e.response = { statusCode: 400, data: { error_description: m } }; return e; }],
    ['e.cause.response.data', (m) => { const e = new Error('x'); e.cause = { response: { data: { error_description: m } } }; return e; }],
    ['e.description als Text', (m) => { const e = new Error('x'); e.description = m; return e; }],
    ['nur e.message', (m) => new Error(m)],
  ]) {
    const rr = await lauf({ action: 'ga4_quick' }, { tokenFehler: bauen('Invalid JWT Signature') });
    pruefe('Begruendung kommt durch (' + name + ')', /Invalid JWT Signature/.test(rr.out.error || ''), rr.out);
  }

  console.log('--- Selbsttest (das ist der Beweis auf dem Server) ---');
  r = await lauf({ action: 'selftest' }, { google: googleStub() });
  pruefe('Selbsttest: eigene Signatur, Token, Property', /eigene RS256-Rechnung ok/.test(r.out.result) && /Token: geholt/.test(r.out.result) && /404505826/.test(r.out.result), r.out.result);
  pruefe('Selbsttest nennt die Properties des Dienstkontos samt Rolle', /sc-domain:salzburgerland\.com \[siteOwner\]/.test(r.out.result), r.out.result);
  pruefe('Selbsttest macht eine echte GA4-Probe', /GA4-Probe: ok/.test(r.out.result), r.out.result);
  r = await lauf({ action: 'selftest' }, { zugang: [] });
  pruefe('Selbsttest ohne Schluessel bleibt lesbar', /Buffer: da/.test(r.out.result) && /nicht eingerichtet/.test(r.out.result), r.out.result);

  console.log('\n' + (n - f) + ' von ' + n + ' Faellen bestanden');
  process.exit(f ? 1 : 0);
})();
