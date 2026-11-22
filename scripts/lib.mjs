// Fungsi bersama untuk pemantau otomatis (update.mjs) dan penambahan manual (manual.mjs).
import fs from 'node:fs/promises';

export const DATA = 'public/data/peraturan.json';
export const META = 'public/data/meta.json';
export const SEEN = 'scripts/state/seen.json';
export const KEY = process.env.GEMINI_API_KEY;
export const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; DirektoriPeraturanBot/1.0)' };
const API = 'https://generativelanguage.googleapis.com';

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const today = () => new Date(Date.now() + 7 * 36e5).toISOString().slice(0, 10); // WIB
export const nowWIB = () => new Date(Date.now() + 7 * 36e5).toISOString().slice(0, 16);
export const log = (...a) => console.log('[jdih]', ...a);

export async function fetchRaw(url, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(60000) });
      if (r.ok) return r;
      log('HTTP', r.status, url);
    } catch (e) { log('gagal', url, e.message); }
    await sleep(4000);
  }
  return null;
}
export async function get(url, tries = 2) { const r = await fetchRaw(url, tries); return r ? r.text() : null; }

export const strip = html => html
  .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<footer[\s\S]*?<\/footer>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ').trim();

// ---------- Gemini ----------
// Unggah PDF besar lewat Files API (protokol resumable), kembalikan part file_data.
export async function pdfPart(buf, name = 'peraturan.pdf') {
  if (buf.length < 15 * 1024 * 1024) {
    return { inline_data: { mime_type: 'application/pdf', data: Buffer.from(buf).toString('base64') } };
  }
  const start = await fetch(`${API}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': KEY, 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(buf.length), 'X-Goog-Upload-Header-Content-Type': 'application/pdf',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: name } }),
  });
  const upUrl = start.headers.get('x-goog-upload-url');
  if (!upUrl) throw new Error('Gagal memulai unggah PDF ke Gemini: HTTP ' + start.status + ' ' + (await start.text()).slice(0, 200));
  const up = await fetch(upUrl, {
    method: 'POST',
    headers: { 'Content-Length': String(buf.length), 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
    body: buf,
  });
  let file = (await up.json()).file;
  for (let i = 0; i < 30 && file?.state === 'PROCESSING'; i++) {
    await sleep(4000);
    file = await (await fetch(`${API}/v1beta/${file.name}`, { headers: { 'x-goog-api-key': KEY } })).json();
  }
  if (!file?.uri || file.state === 'FAILED') throw new Error('Gemini gagal memproses PDF');
  return { file_data: { mime_type: 'application/pdf', file_uri: file.uri } };
}

export async function askGemini(parts) {
  const url = `${API}/v1beta/models/${MODEL}:generateContent`;
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } }),
      signal: AbortSignal.timeout(180000),
    }).catch(e => ({ ok: false, status: 0, text: async () => e.message }));
    if (r.ok) {
      const j = await r.json();
      const t = j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
      try { return JSON.parse(t.replace(/^```json\s*|```$/g, '')); } catch { log('JSON Gemini tidak valid'); return null; }
    }
    log('Gemini HTTP', r.status, (await r.text()).slice(0, 300));
    if (r.status === 429 || r.status >= 500) { await sleep(30000 * (i + 1)); continue; }
    return null;
  }
  return null;
}

export const SCHEMA = `{"relevan":bool,"alasan":"satu kalimat","kategori":"Penganggaran|Pengadaan|BMN","jenis":"UU|PP|Perpres|PMK|Peraturan LKPP|SE LKPP|Keputusan LKPP|Inpres|Lainnya","nomor":"string, mis. 54 atau 113/PMK.05/2012","tahun":2026,"judul":"judul resmi tanpa kata 'tentang'","tanggal":"YYYY-MM-DD tanggal pengundangan/penetapan, atau string kosong bila tidak pasti","status":"Berlaku|Dicabut","relasi":"teks singkat: mencabut/mengubah/dilaksanakan dengan apa","ringkasan":"1-3 kalimat bahasa Indonesia, parafrase sendiri, apa yang diatur dan siapa terdampak","poin":["2-5 butir praktis bagi satker: apa yang berubah, mulai kapan, apa yang harus disesuaikan"],"mencabut":[{"jenis":"...","nomor":"...","tahun":2021}],"mengubah":[{"jenis":"...","nomor":"...","tahun":2021}]}`;

export const SCOPE = `LINGKUP: (1) penganggaran & pelaksanaan APBN (perencanaan, RKA, DIPA, revisi, standar biaya SBM/SBK, pembayaran, perjalanan dinas, bantuan pemerintah, akuntansi & pelaporan keuangan instansi, UU APBN dan Perpres rincian APBN), (2) pengadaan barang/jasa pemerintah, (3) barang milik negara — yang berlaku umum bagi semua satuan kerja/K/L.
DI LUAR LINGKUP: peraturan internal satu instansi/unit (organisasi, kelas jabatan, renstra, penghargaan pegawai, penghapusan BMN milik instansi itu sendiri, tarif PNBP satu kementerian), perpajakan, kepabeanan/cukai, aturan khusus pemerintah daerah (APBD, TKD), sektor khusus (migas, batubara, IKN, TNI), dan keputusan penetapan individual.`;

// ---------- id & data ----------
export const PREFIX = { UU: 'uu', PP: 'pp', Perpres: 'perpres', PMK: 'pmk', 'Peraturan LKPP': 'lkpp', 'SE LKPP': 'se-lkpp', 'Keputusan LKPP': 'kep-lkpp', Inpres: 'inpres' };
const num = n => String(n || '').match(/\d+/)?.[0] || '0';
export const keyOf = (jenis, nomor, tahun) => `${PREFIX[jenis] || String(jenis || 'lain').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${num(nomor)}-${tahun}`;

export async function loadAll() {
  const data = JSON.parse(await fs.readFile(DATA, 'utf8'));
  const meta = JSON.parse(await fs.readFile(META, 'utf8').catch(() => '{}'));
  const seen = JSON.parse(await fs.readFile(SEEN, 'utf8').catch(() => '{}'));
  const byKey = new Map(data.map(d => [keyOf(d.jenis, d.nomor, d.tahun), d]));
  return { data, meta, seen, byKey };
}

export function buildEntry(g, extra) {
  return {
    id: keyOf(g.jenis, g.nomor, g.tahun), kategori: ['Penganggaran', 'Pengadaan', 'BMN'].includes(g.kategori) ? g.kategori : 'Penganggaran',
    jenis: g.jenis, nomor: String(g.nomor), tahun: Number(g.tahun), judul: g.judul,
    ...(/^\d{4}-\d{2}-\d{2}$/.test(g.tanggal || '') ? { tanggal: g.tanggal } : {}),
    status: g.status === 'Dicabut' ? 'Dicabut' : 'Berlaku', relasi: g.relasi || '', ringkasan: g.ringkasan || '',
    poin: Array.isArray(g.poin) ? g.poin.slice(0, 6) : [], ditambahkan: today(), ...extra,
  };
}

export function applyRelations(entry, g, byKey) {
  const ref = `${g.jenis} ${g.nomor}/${g.tahun}`;
  for (const x of g.mencabut || []) {
    const old = byKey.get(keyOf(x.jenis, x.nomor, x.tahun));
    if (old && old !== entry && old.status !== 'Dicabut') { old.status = 'Dicabut'; old.relasi = `Dicabut oleh ${ref}${entry.tanggal ? ' (' + entry.tanggal + ')' : ''}. ` + (old.relasi || ''); }
  }
  for (const x of g.mengubah || []) {
    const old = byKey.get(keyOf(x.jenis, x.nomor, x.tahun));
    if (old && old !== entry && !(old.relasi || '').includes(ref)) old.relasi = `${old.relasi ? old.relasi + ' ' : ''}Diubah dengan ${ref}.`;
  }
}

export async function saveAll({ data, meta, seen }, note, addedIds) {
  meta.terakhir = nowWIB();
  meta.catatan = note;
  meta.riwayat = [{ waktu: meta.terakhir, baru: addedIds.length, catatan: note, ditambahkan: addedIds }, ...(meta.riwayat || [])].slice(0, 30);
  await fs.writeFile(DATA, JSON.stringify(data, null, 0).replace(/},{/g, '},\n{') + '\n');
  await fs.writeFile(META, JSON.stringify(meta, null, 2) + '\n');
  await fs.writeFile(SEEN, JSON.stringify(Object.fromEntries(Object.entries(seen).slice(-3000)), null, 0) + '\n');
}

export async function setOutput(obj) {
  if (!process.env.GITHUB_OUTPUT) return;
  await fs.appendFile(process.env.GITHUB_OUTPUT, Object.entries(obj).map(([k, v]) => `${k}=${String(v).replace(/\n/g, ' ')}`).join('\n') + '\n');
}
