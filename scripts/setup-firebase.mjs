// Setup sekali jalan (workflow "Setup admin Firebase"):
// 1) aktifkan MFA Authenticator (TOTP) di proyek, 2) tandai akun admin + email terverifikasi,
// 3) cabut akun yang diminta, 4) pasang aturan keamanan Firestore.
// Env: FIREBASE_SERVICE_ACCOUNT, FIREBASE_PROJECT_ID, ADMIN_EMAILS (dipisah koma/spasi), CABUT_EMAILS (opsional)
import fs from 'node:fs/promises';
import { gapi, projectId } from './google.mjs';

const P = projectId();
const IT = `https://identitytoolkit.googleapis.com`;
const list = s => (s || '').split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(x => /@/.test(x));
let gagal = 0;
const step = async (label, fn) => { try { const m = await fn(); console.log('✓', label, m ? '— ' + m : ''); } catch (e) { gagal++; console.log('✗', label, '—', e.message); } };

await step('Aktifkan MFA Authenticator (TOTP)', async () => {
  await gapi(`${IT}/admin/v2/projects/${P}/config?updateMask=mfa`, {
    method: 'PATCH',
    body: JSON.stringify({ mfa: { providerConfigs: [{ state: 'ENABLED', totpProviderConfig: { adjacentIntervals: 1 } }] } }),
  });
  return 'admin wajib memakai aplikasi Authenticator';
});

async function lookup(email) {
  const j = await gapi(`${IT}/v1/projects/${P}/accounts:lookup`, { method: 'POST', body: JSON.stringify({ email: [email] }) });
  return j?.users?.[0];
}

for (const email of list(process.env.ADMIN_EMAILS)) {
  await step(`Jadikan admin: ${email}`, async () => {
    const u = await lookup(email);
    if (!u) throw new Error('akun belum ada — buat dulu di Firebase Console → Authentication → Users → Add user');
    await gapi(`${IT}/v1/projects/${P}/accounts:update`, {
      method: 'POST',
      body: JSON.stringify({ localId: u.localId, emailVerified: true, disableUser: false, customAttributes: JSON.stringify({ admin: true }) }),
    });
    return 'siap; saat masuk pertama kali akan diminta memasang MFA';
  });
}

for (const email of list(process.env.CABUT_EMAILS)) {
  await step(`Cabut admin: ${email}`, async () => {
    const u = await lookup(email);
    if (!u) return 'akun tidak ditemukan, dilewati';
    await gapi(`${IT}/v1/projects/${P}/accounts:update`, {
      method: 'POST',
      body: JSON.stringify({ localId: u.localId, customAttributes: JSON.stringify({}), validSince: String(Math.floor(Date.now() / 1000)) }),
    });
    return 'hak admin dicabut dan semua sesinya diakhiri';
  });
}

await step('Pasang aturan keamanan Firestore', async () => {
  const content = await fs.readFile('firestore.rules', 'utf8');
  const rs = await gapi(`https://firebaserules.googleapis.com/v1/projects/${P}/rulesets`, {
    method: 'POST', body: JSON.stringify({ source: { files: [{ name: 'firestore.rules', content }] } }),
  });
  const name = `projects/${P}/releases/cloud.firestore`;
  try {
    await gapi(`https://firebaserules.googleapis.com/v1/${name}`, { method: 'PATCH', body: JSON.stringify({ release: { name, rulesetName: rs.name } }) });
  } catch (e) {
    if (e.status !== 404) throw e;
    await gapi(`https://firebaserules.googleapis.com/v1/projects/${P}/releases`, { method: 'POST', body: JSON.stringify({ name, rulesetName: rs.name }) });
  }
  return rs.name.split('/').pop();
});

if (gagal) { console.log(`\n${gagal} langkah gagal. Baca pesan di atas; lihat juga tabel Pemecahan masalah di panduan.`); process.exit(1); }
console.log('\nSelesai.');
