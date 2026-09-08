// Prueft, wie die Teams-Bruecke Installations- und Mitgliedsereignisse liest.
// Laeuft ohne Server: index.js startet nur, wenn es direkt aufgerufen wird.
//   cd teams-bridge && npm install --omit=dev && cd .. && node tests/teams-bridge-mitgliedschaft.test.js
process.env.MS_APP_ID = process.env.MS_APP_ID || 'bec99604-0000-4000-8000-000000000001';
const assert = require('node:assert/strict');
const { mitgliedschaftAusActivity, istNeueInstallation } = require('../teams-bridge/src/index.js');

const APP = process.env.MS_APP_ID;
let n = 0, fehler = 0;
function fall(name, fn) {
  n++;
  try { fn(); console.log('PASS', name); }
  catch (e) { fehler++; console.log('FAIL', name, '\n     ', e.message); }
}

// Beispiel nach Microsoft-Doku: installationUpdate ohne from.name, persoenlicher Chat.
const install = {
  type: 'installationUpdate', action: 'add', id: 'f:1', timestamp: '2026-09-08T06:10:04Z',
  serviceUrl: 'https://smba.trafficmanager.net/emea/',
  from: { id: '29:abc', aadObjectId: '11111111-2222-4333-8444-555555555555' },
  conversation: { id: 'a:konv1', conversationType: 'personal', tenantId: '77bb16bd-0000-4000-8000-000000000000' },
  channelData: { tenant: { id: '77bb16bd-0000-4000-8000-000000000000' } }
};

fall('installationUpdate add im persoenlichen Chat ist eine neue Installation', () => {
  const m = mitgliedschaftAusActivity(install);
  assert.equal(m.typ, 'installationUpdate');
  assert.equal(m.action, 'add');
  assert.equal(m.aadObjectId, '11111111-2222-4333-8444-555555555555');
  assert.equal(m.conversationId, 'a:konv1');
  assert.equal(m.conversationType, 'personal');
  assert.equal(m.tenantId, '77bb16bd-0000-4000-8000-000000000000');
  assert.equal(m.serviceUrl, 'https://smba.trafficmanager.net/emea/');
  assert.equal(m.fromName, '');
  assert.equal(istNeueInstallation(m), true);
});

fall('installationUpdate remove ist keine Installation, wird aber gelesen', () => {
  const m = mitgliedschaftAusActivity(Object.assign({}, install, { action: 'remove' }));
  assert.equal(m.action, 'remove');
  assert.equal(istNeueInstallation(m), false);
});

fall('installationUpdate add im Team (Kanal) loest keine Begruessung aus', () => {
  const m = mitgliedschaftAusActivity(Object.assign({}, install, {
    conversation: { id: '19:kanal@thread.tacv2', conversationType: 'channel', isGroup: true }
  }));
  assert.equal(m.conversationType, 'channel');
  assert.equal(istNeueInstallation(m), false);
});

fall('conversationUpdate mit Bot unter membersAdded im persoenlichen Chat zaehlt als Installation', () => {
  const m = mitgliedschaftAusActivity({
    type: 'conversationUpdate', id: 'f:2', serviceUrl: 'https://smba.trafficmanager.net/emea/',
    membersAdded: [{ id: '28:' + APP }, { id: '29:abc', aadObjectId: '11111111-2222-4333-8444-555555555555' }],
    from: { id: '29:abc', aadObjectId: '11111111-2222-4333-8444-555555555555' },
    conversation: { id: 'a:konv1', conversationType: 'personal' },
    channelData: { tenant: { id: '77bb16bd-0000-4000-8000-000000000000' } }
  });
  assert.equal(m.botHinzu, true);
  assert.equal(m.hinzu.length, 2);
  assert.equal(m.aadObjectId, '11111111-2222-4333-8444-555555555555');
  assert.equal(istNeueInstallation(m), true);
});

fall('conversationUpdate ohne Bot unter membersAdded (z. B. Person tritt Gruppenchat bei) ist keine Installation', () => {
  const m = mitgliedschaftAusActivity({
    type: 'conversationUpdate', id: 'f:3', serviceUrl: 'https://smba.trafficmanager.net/emea/',
    membersAdded: [{ id: '29:xyz', aadObjectId: '99999999-2222-4333-8444-555555555555' }],
    from: { id: '29:abc', aadObjectId: '11111111-2222-4333-8444-555555555555' },
    conversation: { id: 'a:konv1', conversationType: 'personal' }
  });
  assert.equal(m.botHinzu, false);
  assert.equal(istNeueInstallation(m), false);
});

fall('conversationUpdate mit Bot unter membersRemoved ist keine Installation', () => {
  const m = mitgliedschaftAusActivity({
    type: 'conversationUpdate', id: 'f:4', serviceUrl: 'https://smba.trafficmanager.net/emea/',
    membersRemoved: [{ id: '28:' + APP }],
    from: { id: '29:abc', aadObjectId: '11111111-2222-4333-8444-555555555555' },
    conversation: { id: 'a:konv1', conversationType: 'personal' }
  });
  assert.equal(m.botWeg, true);
  assert.equal(m.weg.length, 1);
  assert.equal(istNeueInstallation(m), false);
});

fall('ohne from.aadObjectId wird die Objekt-ID aus membersAdded genommen (nicht die des Bots)', () => {
  const m = mitgliedschaftAusActivity({
    type: 'conversationUpdate', id: 'f:5', serviceUrl: 'https://smba.trafficmanager.net/emea/',
    membersAdded: [{ id: '28:' + APP }, { id: '29:abc', aadObjectId: '11111111-2222-4333-8444-555555555555', name: 'Strasser, Sophie' }],
    from: { id: '28:' + APP },
    conversation: { id: 'a:konv1', conversationType: 'personal' }
  });
  assert.equal(m.aadObjectId, '11111111-2222-4333-8444-555555555555');
  assert.equal(m.fromName, 'Strasser, Sophie');
  assert.equal(istNeueInstallation(m), true);
});

fall('ohne Objekt-ID nie eine Installation', () => {
  const m = mitgliedschaftAusActivity({ type: 'installationUpdate', action: 'add', conversation: { id: 'a:k', conversationType: 'personal' } });
  assert.equal(m.aadObjectId, '');
  assert.equal(istNeueInstallation(m), false);
});

fall('kaputte Nutzlast (null, Strings statt Objekte) wirft nicht', () => {
  assert.doesNotThrow(() => mitgliedschaftAusActivity(null));
  assert.doesNotThrow(() => mitgliedschaftAusActivity({ type: 'conversationUpdate', membersAdded: 'x', membersRemoved: [null, 5] }));
  assert.equal(istNeueInstallation(mitgliedschaftAusActivity(null)), false);
});

fall('Mandant faellt auf conversation.tenantId zurueck, wenn channelData fehlt', () => {
  const m = mitgliedschaftAusActivity(Object.assign({}, install, { channelData: undefined }));
  assert.equal(m.tenantId, '77bb16bd-0000-4000-8000-000000000000');
});

console.log('\n' + (n - fehler) + ' von ' + n + ' Faellen bestanden');
process.exit(fehler ? 1 : 0);
