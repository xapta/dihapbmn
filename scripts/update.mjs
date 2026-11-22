// Pemantau peraturan baru JDIH Kemenkeu & JDIH LKPP (dijalankan harian oleh GitHub Actions).
// Env: GEMINI_API_KEY (wajib), GEMINI_MODEL, MAX_CANDIDATES, DRY_RUN=1
import { KEY, sleep, today, log, get, strip, askGemini, SCHEMA, SCOPE, keyOf, loadAll, buildEntry, applyRelations, saveAll, setOutput } from './lib.mjs';

const MAX = Number(process.env.MAX_CANDIDATES || 10);
const DRY = process.env.DRY_RUN === '1';

async function kemenkeuCandidates() {
  const txt = await get('https://jdih.kemenkeu.go.id/feed.json');
  if (!txt) return { ok: false, items: [] };
  let feed; try { feed = JSON.parse(txt); } catch { return { ok: false, items: [] }; }
  const items = (feed.items || [])
    .filter(it => /^(PMK|PP|UU|PERPRES)\b/i.test((it.title || '').trim())) // KMK/PER/KEP Ditjen (pajak, BC, dll.) dilewati
    .map(it => ({ url: it.url, title: it.title, hint: strip(it.content_html || ''), sumber: 'JDIH Kemenkeu' }));
  return { ok: true, items };
}

const LKPP_TYPES = 'peraturan-lkpp|peraturan-presiden|surat-edaran-kepala-lkpp|keputusan-kepala-lkpp|peraturan-kepala-lkpp';
async function lkppCandidates() {
  const pages = ['https://jdih.lkpp.go.id/', ...LKPP_TYPES.split('|').map(t => `https://jdih.lkpp.go.id/regulation/${t}`)];
  const re = new RegExp(`(?:https?://jdih\\.lkpp\\.go\\.id)?/regulation/(${LKPP_TYPES})/[a-z0-9-]+-nomor-\\d+-tahun-\\d{4}`, 'g');
  const found = new Map(); let okAny = false;
  for (const p of pages) {
    const html = await get(p);
    if (!html) continue;
    okAny = true;
    for (const m of html.matchAll(re)) {
      const url = m[0].startsWith('http') ? m[0] : 'https://jdih.lkpp.go.id' + m[0];
      if (!found.has(url)) found.set(url, { url, title: url.split('/').pop().replace(/-/g, ' '), hint: '', sumber: 'JDIH LKPP' });
    }
    await sleep(1500);
  }
  return { ok: okAny, items: [...found.values()] };
}

async function detailText(c) {
  const parts = [];
  const pages = c.sumber === 'JDIH Kemenkeu' ? [c.url.replace(/\/$/, ''), c.url.replace(/\/$/, '') + '/summary'] : [c.url];
  for (const u of pages) { const h = await get(u, 1); if (h) parts.push(strip(h)); }
  if (c.hint) parts.push('Ringkasan feed: ' + c.hint);
  return parts.join('\n\n').slice(0, 14000);
}

const PROMPT = (c, text) => `Anda analis hukum keuangan negara Indonesia. Nilai satu produk hukum berikut untuk direktori peraturan bagi SEMUA satuan kerja kementerian/lembaga. "relevan" = true hanya bila masuk LINGKUP.

${SCOPE}

Jawab HANYA JSON dengan bentuk:
${SCHEMA}
Jangan menebak nomor atau tanggal. Jika teks hanya berisi metadata, rangkum dari judul dan nyatakan itu di salah satu poin.

Sumber: ${c.sumber}
URL: ${c.url}
Judul di daftar: ${c.title}

TEKS HALAMAN:
${text}`;

async function main() {
  if (!KEY && !DRY) throw new Error('GEMINI_API_KEY belum diisi (GitHub → Settings → Secrets → Actions).');
  const st = await loadAll();
  const knownUrls = new Set(st.data.flatMap(d => [d.url, d.sumberUrl].filter(Boolean)));

  const [kk, lk] = await Promise.all([kemenkeuCandidates(), lkppCandidates()]);
  const notes = [];
  if (!kk.ok) notes.push('JDIH Kemenkeu tidak dapat dijangkau');
  if (!lk.ok) notes.push('JDIH LKPP tidak dapat dijangkau');

  const candidates = [...kk.items, ...lk.items].filter(c => !knownUrls.has(c.url) && !st.seen[c.url]).slice(0, MAX);
  log(`kandidat baru: ${candidates.length} (Kemenkeu ${kk.items.length}, LKPP ${lk.items.length} total terlihat)`);

  const added = [];
  for (const c of candidates) {
    const text = await detailText(c);
    if (DRY) { log('DRY', c.url, text.slice(0, 120)); continue; }
    const g = await askGemini([{ text: PROMPT(c, text) }]);
    await sleep(6000); // jaga batas permintaan per menit tingkat gratis
    if (!g) { log('lewati (Gemini gagal), dicoba lagi besok:', c.url); continue; }
    st.seen[c.url] = { t: today(), relevan: !!g.relevan, alasan: g.alasan || '' };
    if (!g.relevan) { log('tidak relevan:', c.title, '-', g.alasan); continue; }
    const id = keyOf(g.jenis, g.nomor, g.tahun);
    if (st.byKey.has(id)) { log('sudah ada:', id); continue; }
    const entry = buildEntry(g, { sumber: c.sumber, url: c.url, otomatis: true });
    st.data.push(entry); st.byKey.set(id, entry); added.push(entry);
    applyRelations(entry, g, st.byKey);
    log('DITAMBAHKAN:', id);
  }

  const note = [added.length ? `${added.length} peraturan baru ditambahkan` : 'Tidak ada peraturan baru yang relevan', ...notes].join('. ');
  if (!DRY) await saveAll(st, note, added.map(a => a.id));
  log(note);
  await setOutput({ added: added.length, summary: added.map(a => `${a.jenis} ${a.nomor}/${a.tahun}`).join(', ') || '-' });
}

main().catch(e => { console.error(e); process.exit(1); });
