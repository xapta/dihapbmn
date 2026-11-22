// Pemroses antrean admin di Firestore (dipanggil workflow "Proses antrean admin" setiap 5 menit).
//   node scripts/antrean.mjs ambil    → ambil permintaan baru, susun PDF ke inbox/, keluarkan link untuk manual.mjs
//   node scripts/antrean.mjs selesai  → tandai hasil (selesai/gagal) di Firestore, hapus potongan PDF
import fs from 'node:fs/promises';
import { fsQuery, fsList, fsPatch, fsDelete } from './google.mjs';

const STATE = '.antrean-berjalan.json';
const out = async obj => { if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, Object.entries(obj).map(([k, v]) => `${k}=${String(v).replace(/[\r\n]+/g, ' ')}`).join('\n') + '\n'); };
const log = (...a) => console.log('[antrean]', ...a);

async function ambil() {
  const baru = await fsQuery('antrean', 'status', 'EQUAL', 'menunggu', 10);
  // permintaan yang macet (proses sebelumnya terhenti > 30 menit) dicoba lagi
  const macet = (await fsQuery('antrean', 'status', 'EQUAL', 'diproses', 10))
    .filter(x => !x.diprosesPada || Date.now() - new Date(x.diprosesPada) > 30 * 60e3);
  const items = [...baru, ...macet].sort((a, b) => String(a.dibuat).localeCompare(String(b.dibuat)));
  if (!items.length) { log('antrean kosong'); await out({ ada: 'false' }); return; }

  const urls = [], notes = [], jalan = [];
  await fs.mkdir('inbox', { recursive: true });
  for (const it of items) {
    try {
      if (it.jenis === 'link') {
        const u = String(it.urls || '').split(/\s+/).filter(x => /^https?:\/\//.test(x));
        if (!u.length) throw new Error('link kosong');
        urls.push(...u); if (it.catatan) notes.push(it.catatan);
        jalan.push({ id: it.id, jenis: 'link', kunci: u });
      } else if (it.jenis === 'pdf') {
        const parts = (await fsList(`antrean/${it.id}/bagian`)).sort((a, b) => a.id.localeCompare(b.id));
        if (parts.length !== Number(it.parts)) throw new Error(`potongan PDF belum lengkap (${parts.length}/${it.parts})`);
        const buf = Buffer.from(parts.map(p => p.data).join(''), 'base64');
        if (buf.subarray(0, 5).toString() !== '%PDF-') throw new Error('berkas bukan PDF');
        const file = `q-${it.id}.pdf`;
        await fs.writeFile(`inbox/${file}`, buf);
        const side = [it.sumber, it.catatan].filter(Boolean).join('\n');
        if (side) await fs.writeFile(`inbox/${file}.txt`, side);
        jalan.push({ id: it.id, jenis: 'pdf', kunci: [file], parts: parts.map(p => p.id) });
      } else throw new Error('jenis tidak dikenal');
      await fsPatch(`antrean/${it.id}`, { status: 'diproses', diprosesPada: new Date(), pesan: 'Sedang dibaca dan dirangkum Gemini' });
      log('diambil', it.id, it.jenis);
    } catch (e) {
      log('gagal menyiapkan', it.id, e.message);
      await fsPatch(`antrean/${it.id}`, { status: 'gagal', pesan: e.message, selesaiPada: new Date() }).catch(() => {});
    }
  }
  await fs.writeFile(STATE, JSON.stringify(jalan));
  await out({ ada: jalan.length ? 'true' : 'false', urls: urls.join(' '), catatan: notes.join(' | ').slice(0, 500) });
}

async function selesai() {
  const jalan = JSON.parse(await fs.readFile(STATE, 'utf8').catch(() => '[]'));
  const failed = (process.env.RESULT_FAILED || '').split(/,\s*/).filter(Boolean);
  const added = (process.env.RESULT_SUMMARY || '').split(/,\s*/).filter(x => x && x !== '-');
  const crashed = process.env.RUN_OUTCOME === 'failure' && !added.length && !failed.length;
  for (const j of jalan) {
    const kena = j.kunci.some(k => failed.some(f => f.includes(k) || k.includes(f)));
    const ok = !crashed && !kena;
    await fsPatch(`antrean/${j.id}`, {
      status: ok ? 'selesai' : 'gagal',
      pesan: ok ? (added.length ? 'Masuk ke direktori: ' + added.join(', ') : 'Diproses; tidak ada peraturan baru (mungkin sudah ada)')
        : crashed ? 'Proses berhenti karena kesalahan; lihat log GitHub Actions' : 'Naskah tidak dapat dibaca atau dirangkum',
      hasil: added, selesaiPada: new Date(),
    }).catch(e => log('gagal menandai', j.id, e.message));
    for (const p of j.parts || []) await fsDelete(`antrean/${j.id}/bagian/${p}`).catch(() => {});
    log(ok ? 'selesai' : 'gagal', j.id);
  }
  await fs.rm(STATE, { force: true });
}

const cmd = process.argv[2];
(cmd === 'ambil' ? ambil() : cmd === 'selesai' ? selesai() : Promise.reject(new Error('pakai: ambil | selesai')))
  .catch(e => { console.error(e.message); process.exit(1); });
