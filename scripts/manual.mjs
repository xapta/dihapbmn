// Penambahan peraturan secara manual: dari link (env MANUAL_URL) dan/atau PDF di folder inbox/.
// Dijalankan oleh workflow "Tambah peraturan manual".
// - Link halaman JDIH/peraturan.bpk.go.id/situs lain, atau link langsung ke PDF.
// - PDF yang diunggah ke inbox/ (lewat panel admin aplikasi atau langsung di GitHub)
//   dipindah ke public/dokumen/<id>.pdf sehingga bisa diunduh dari aplikasi.
import fs from 'node:fs/promises';
import path from 'node:path';
import { KEY, log, fetchRaw, strip, askGemini, pdfPart, SCHEMA, SCOPE, keyOf, loadAll, buildEntry, applyRelations, saveAll, setOutput, sleep } from './lib.mjs';

const INBOX = 'inbox';
const DOCS = 'public/dokumen';
const SITE = process.env.SITE_URL || ''; // opsional, untuk url absolut dokumen

const PROMPT = (asal, catatan) => `Anda analis hukum keuangan negara Indonesia. Admin direktori peraturan menambahkan dokumen di bawah ini secara manual. Ekstrak metadatanya dan buat rangkuman untuk satuan kerja kementerian/lembaga.
Dokumen tetap dimasukkan walau di luar lingkup; isi "relevan" dan "alasan" sebagai catatan saja, dan pilih "kategori" yang paling dekat.

${SCOPE}

Jawab HANYA JSON dengan bentuk:
${SCHEMA}
Ambil nomor, tahun, dan tanggal dari naskah; jangan menebak. "status" = "Berlaku" kecuali naskah/halaman jelas menyebut sudah dicabut.
Asal dokumen: ${asal}${catatan ? `\nCatatan admin: ${catatan}` : ''}`;

async function fromUrl(url, catatan) {
  const r = await fetchRaw(url);
  if (!r) throw new Error('Link tidak dapat dibuka: ' + url);
  const type = r.headers.get('content-type') || '';
  const buf = Buffer.from(await r.arrayBuffer());
  const isPdf = type.includes('pdf') || buf.subarray(0, 5).toString() === '%PDF-';
  const parts = [{ text: PROMPT('link ' + url, catatan) }];
  if (isPdf) parts.push(await pdfPart(buf, path.basename(new URL(url).pathname) || 'peraturan.pdf'));
  else parts.push({ text: 'TEKS HALAMAN:\n' + strip(buf.toString('utf8')).slice(0, 30000) });
  return { parts, url, isPdf };
}

const sumberOf = url => /jdih\.kemenkeu/.test(url) ? 'JDIH Kemenkeu' : /jdih\.lkpp/.test(url) ? 'JDIH LKPP' : /peraturan\.bpk/.test(url) ? 'JDIH BPK' : 'Ditambahkan manual';

async function upsert(st, g, extra) {
  const id = keyOf(g.jenis, g.nomor, g.tahun);
  const entry = buildEntry(g, { manual: true, otomatis: false, ...extra });
  const old = st.byKey.get(id);
  if (old) {
    const i = st.data.indexOf(old);
    st.data[i] = { ...old, ...entry, ditambahkan: old.ditambahkan, url: entry.url || old.url };
    st.byKey.set(id, st.data[i]);
    log('DIPERBARUI:', id);
  } else {
    st.data.push(entry); st.byKey.set(id, entry);
    log('DITAMBAHKAN:', id);
  }
  applyRelations(st.byKey.get(id), g, st.byKey);
  return id;
}

async function main() {
  if (!KEY) throw new Error('GEMINI_API_KEY belum diisi (GitHub → Settings → Secrets → Actions).');
  const st = await loadAll();
  const done = [], failed = [];
  const catatan = (process.env.MANUAL_NOTE || '').trim();

  // 1) Link
  const links = (process.env.MANUAL_URL || '').split(/\s+/).filter(u => /^https?:\/\//.test(u));
  for (const url of links) {
    try {
      const { parts, isPdf } = await fromUrl(url, catatan);
      const g = await askGemini(parts);
      if (!g?.jenis || !g?.tahun) throw new Error('Gemini tidak bisa membaca metadata dari link ini');
      const id = await upsert(st, g, { sumber: sumberOf(url), url, ...(isPdf ? { berkas: url } : {}) });
      st.seen[url] = { t: new Date().toISOString().slice(0, 10), relevan: true, alasan: 'ditambahkan manual' };
      done.push(id);
    } catch (e) { log('GAGAL', url, e.message); failed.push(url); }
    await sleep(5000);
  }

  // 2) PDF di inbox/
  const files = (await fs.readdir(INBOX).catch(() => [])).filter(f => /\.pdf$/i.test(f));
  await fs.mkdir(DOCS, { recursive: true });
  for (const f of files) {
    const p = path.join(INBOX, f);
    try {
      const buf = await fs.readFile(p);
      // Catatan/link sumber opsional di file pendamping: <nama>.pdf.txt
      const side = await fs.readFile(p + '.txt', 'utf8').catch(() => '');
      const srcUrl = side.match(/https?:\/\/\S+/)?.[0] || '';
      const g = await askGemini([{ text: PROMPT('berkas PDF ' + f, [catatan, side.trim()].filter(Boolean).join(' | ')) }, await pdfPart(buf, f)]);
      if (!g?.jenis || !g?.tahun) throw new Error('Gemini tidak bisa membaca metadata dari PDF ini');
      const id = keyOf(g.jenis, g.nomor, g.tahun);
      const dest = path.join(DOCS, `${id}.pdf`);
      await fs.rename(p, dest);
      await fs.rm(p + '.txt', { force: true });
      const berkas = (SITE ? SITE.replace(/\/$/, '') : '') + `/dokumen/${id}.pdf`;
      await upsert(st, g, { sumber: srcUrl ? sumberOf(srcUrl) : 'Ditambahkan manual', url: srcUrl || berkas, berkas });
      done.push(id);
    } catch (e) { log('GAGAL', f, e.message); failed.push(f); }
    await sleep(5000);
  }

  if (!links.length && !files.length) log('Tidak ada link maupun PDF di inbox/ untuk diproses.');
  const note = `Tambah manual: ${done.length} berhasil${failed.length ? `, ${failed.length} gagal (${failed.join(', ')})` : ''}`;
  if (done.length) await saveAll(st, note, done);
  log(note);
  await setOutput({ added: done.length, summary: done.join(', ') || '-', failed: failed.join(', ') || '' });
  if (failed.length && !done.length) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
