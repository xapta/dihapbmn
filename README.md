# Direktori Peraturan Penganggaran, Pengadaan, dan BMN

Aplikasi web statis berisi peraturan yang berlaku umum bagi seluruh satuan kerja, bersumber dari **JDIH Kemenkeu** dan **JDIH LKPP**. Setiap pagi ada pengecekan otomatis: kalau ada peraturan baru yang relevan, peraturan itu masuk ke aplikasi lengkap dengan rangkumannya. Semua komponennya memakai layanan gratis.

```
GitHub Actions (06:38 WIB setiap hari)
  ├─ baca jdih.kemenkeu.go.id/feed.json + halaman terbaru jdih.lkpp.go.id
  ├─ peraturan baru → Gemini API (gratis): relevan atau tidak? buat rangkuman
  ├─ simpan ke public/data/peraturan.json (commit ke repositori)
  └─ deploy ke Firebase Hosting (paket Spark, gratis) → domain Anda
```

## Isi folder

| Berkas | Fungsi |
|---|---|
| `public/index.html` | Aplikasi (pencarian, filter kategori/jenis/status, rangkuman) |
| `public/data/peraturan.json` | Data peraturan (63 data awal) |
| `public/data/meta.json` | Waktu pengecekan terakhir dan riwayatnya |
| `scripts/update.mjs` | Pemantau JDIH dan perangkum harian (Node 20, tanpa dependensi) |
| `scripts/manual.mjs` | Penambahan manual dari link atau PDF di `inbox/` |
| `scripts/lib.mjs` | Fungsi bersama (Gemini, data, relasi cabut/ubah) |
| `inbox/` | Tempat PDF yang menunggu diproses |
| `public/dokumen/` | PDF yang sudah diproses, bisa diunduh dari aplikasi |
| `.github/workflows/tambah-manual.yml` | Memproses link/PDF manual, lalu deploy |
| `scripts/state/seen.json` | Daftar URL yang sudah pernah dinilai, supaya tidak dinilai ulang |
| `.github/workflows/update.yml` | Jadwal harian: cek, simpan, deploy |
| `.github/workflows/deploy.yml` | Deploy otomatis saat Anda mengubah isi `public/` |

## Langkah pemasangan (sekali saja, sekitar 20 menit)

### 1. Proyek Firebase
1. Buka https://console.firebase.google.com, klik **Create a project**. Biarkan di paket **Spark** (gratis), tidak perlu kartu kredit.
2. Di menu **Build → Hosting**, klik **Get started** (langkah CLI boleh dilewati).
3. Catat **Project ID** (contoh: `direktori-peraturan-1a2b3`).
4. Buka **Project settings → Service accounts → Generate new private key**. Simpan file JSON-nya. File ini rahasia, jangan diunggah ke repositori.

### 2. Kunci API Gemini (gratis)
1. Buka https://aistudio.google.com, lalu **Get API key → Create API key**.
2. Salin kuncinya.

### 3. Repositori GitHub
1. Buat repositori baru, misalnya `direktori-peraturan`. Repositori **publik** membuat GitHub Actions gratis tanpa batas menit.
2. Unggah seluruh isi folder ini (termasuk folder `.github`).
3. Ganti `GANTI-DENGAN-ID-PROYEK-FIREBASE` di `.firebaserc` dengan Project ID Anda.
4. Buka **Settings → Secrets and variables → Actions**:
   - Tab **Secrets → New repository secret**:
     - `GEMINI_API_KEY`: kunci dari langkah 2
     - `FIREBASE_SERVICE_ACCOUNT`: tempel **seluruh isi** file JSON dari langkah 1.4
   - Tab **Variables → New repository variable**:
     - `FIREBASE_PROJECT_ID`: Project ID Anda
     - (opsional) `GEMINI_MODEL`: isi bila model bawaan `gemini-3.1-flash-lite` sudah tidak tersedia
5. Buka **Settings → Actions → General → Workflow permissions**, lalu pilih **Read and write permissions**.

### 4. Jalankan pertama kali
Buka tab **Actions → Pantau peraturan JDIH → Run workflow**. Setelah selesai (hijau), aplikasi sudah tayang di `https://<project-id>.web.app`.

> Pada beberapa hari pertama, pemantau juga menilai peraturan lama yang masih tampil di daftar JDIH, maksimal 10 per hari. Peraturan yang tidak relevan dicatat di `seen.json` dan tidak dinilai lagi.

### 5. Domain sendiri
Firebase Console → **Hosting → Add custom domain**. Masukkan domainnya (mis. `peraturan.namainstansi.go.id`), lalu tambahkan record DNS yang diminta (TXT untuk verifikasi, lalu A/CNAME) di pengelola DNS domain Anda. Sertifikat SSL dibuat otomatis, biasanya dalam beberapa jam.

## Menambah peraturan secara manual (link atau PDF)

Ada tiga cara. Ketiganya diproses workflow **Tambah peraturan manual**: Gemini membaca naskahnya, mengisi nomor/tahun/judul, membuat rangkuman, lalu peraturan masuk ke direktori dalam 2–5 menit dengan label *Ditambahkan manual*. Peraturan yang sudah ada dengan nomor yang sama akan diperbarui rangkumannya.

1. **Dari aplikasi (paling mudah).** Buka `https://domain-anda/#admin` → tombol **+ Tambah peraturan**. Sekali per perangkat, isi *Pengaturan admin*: repositori (`akun/nama-repo`) dan token GitHub fine-grained untuk repositori ini dengan izin **Contents: Read and write** dan **Actions: Read and write**. Setelah itu pilih **Dari link** atau **Unggah PDF**.
2. **Dari GitHub (link).** Tab **Actions → Tambah peraturan manual → Run workflow**, lalu isi kolom link.
3. **Dari GitHub (PDF).** Buka folder `inbox/` → **Add file → Upload files** → unggah PDF → Commit. Link sumber resmi bisa ditaruh di file `<nama>.pdf.txt`.

PDF yang diunggah dipindah ke `public/dokumen/<id>.pdf` dan bisa diunduh dari aplikasi (tombol **Unduh PDF**). PDF di atas 15 MB dikirim lewat Gemini Files API (otomatis). Batas unggah dari aplikasi 50 MB per file.

## Perawatan

- **Ubah jam pengecekan:** edit baris `cron` di `.github/workflows/update.yml` (waktu dalam UTC; WIB = UTC+7).
- **Koreksi rangkuman:** edit `public/data/peraturan.json` langsung di GitHub. Workflow deploy akan menayangkannya otomatis.
- **Hapus peraturan yang keliru masuk:** hapus objeknya dari `peraturan.json`. URL-nya sudah tercatat di `seen.json`, jadi tidak akan masuk lagi.
- **Cek tanpa menulis apa pun:** `npm run cek` (mode uji, tidak memanggil Gemini).
- **Model Gemini dihentikan Google:** isi variabel `GEMINI_MODEL` dengan model Flash/Flash-Lite yang berlaku di https://ai.google.dev/gemini-api/docs/models.

## Batasan

- JDIH LKPP tidak menyediakan feed, jadi datanya dibaca dari halaman HTML. Kalau tampilan situsnya berubah, pola tautan di `scripts/update.mjs` (`LKPP_TYPES` dan regex di `lkppCandidates`) perlu disesuaikan.
- Rangkuman dibuat AI dari halaman detail JDIH. Kalau naskah lengkap tidak tampil di halaman, rangkuman hanya berdasarkan judul dan metadata. Entri otomatis ditandai **Masuk otomatis** supaya mudah diperiksa.
- Di tingkat gratis, Google dapat memakai data permintaan Gemini untuk meningkatkan produknya. Yang dikirim hanyalah teks peraturan publik.
