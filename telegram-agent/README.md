# Kizora Telegram Agent

Bot Telegram coding-agent: konek GitHub, pilih project, lalu kirim prompt — agent membaca/menulis file, menjalankan command, commit & push, semuanya dari chat Telegram.

## Fitur

- **Setting LLM OpenAI-compatible** — base URL, token, model (OpenAI, OpenRouter, DeepSeek, Groq, Ollama, vLLM, dll)
- **Konek GitHub** — validasi token, list repo, clone/pull otomatis ke workspace lokal
- **Agentic loop** — LLM pakai tools: `list_files`, `read_file`, `write_file`, `edit_file`, `run_command`, `git_status`, `git_commit`, `git_push`, `git_pull`
- **Kerja dari banyak mesin** — `/pull` (atau tool `git_pull`) menarik perubahan terbaru dari remote sebelum agent mulai mengedit, supaya tidak bentrok dengan yang sudah di-push dari laptop/VPS lain. Saat pilih project di `/repos`, repo juga otomatis di-pull kalau sudah ada.
- **Mode akses**
  - `ASK` — setiap aksi yang mengubah sesuatu (tulis file, edit, command, commit, push) minta konfirmasi via tombol ✅/❌ dulu. Aksi read-only (baca file, list, git status) jalan langsung.
  - `FULL` — semua aksi langsung dijalankan tanpa konfirmasi
- **Auto-push** — setelah agent selesai, sisa perubahan otomatis di-commit & push ke GitHub (opsional, bisa ON/OFF)
- **Riwayat percakapan** per project, `/reset` untuk bersihkan
- **`/cancel`** — batalkan tugas yang sedang jalan kapan saja

## Setup

### 1. Prasyarat

- Node.js >= 18
- Git terinstall
- Token bot dari [@BotFather](https://t.me/BotFather)
- Token LLM (dari provider pilihanmu)
- Token GitHub (scope `repo`) — buat di https://github.com/settings/tokens

### 2. Install

```bash
cd telegram-agent
npm install
cp .env.example .env
```

Edit `.env`, isi minimal:

```
TELEGRAM_BOT_TOKEN=123456:ABC...
```

Opsional:

```
ALLOWED_TELEGRAM_IDS=123456789     # batasi user (csv), kosong = semua boleh
AGENT_MAX_ITERATIONS=25            # batas iterasi agent per prompt
APPROVAL_TIMEOUT_MS=900000         # timeout approval mode ASK (15 menit)
```

### 3. Jalankan

```bash
npm start
```

### 4. Setup dari Telegram

1. `/settings` → tombol **Base URL**, **Token**, **Model** (atau `/setbase`, `/settoken`, `/setmodel`)
2. Tombol **🧪 Test Koneksi LLM** untuk memastikan setting benar
3. `/connect ghp_xxx` → konek GitHub
4. `/repos` → pilih project (auto clone ke folder `workspace/`)
5. Kirim prompt, misalnya: *"tambahkan fitur login di src/auth.js"* — agent kerja

## Daftar perintah

| Perintah | Fungsi |
|---|---|
| `/start` | Panduan setup singkat |
| `/settings` | Lihat & ubah setting (tombol interaktif) |
| `/setbase <url>` | Set base URL LLM |
| `/settoken <token>` | Set token LLM |
| `/setmodel <nama>` | Set model |
| `/mode full\|ask` | Mode akses |
| `/autopush on\|off` | Auto commit+push setelah selesai |
| `/connect <token>` | Konek GitHub |
| `/repos` | Pilih project |
| `/pull` | Tarik perubahan terbaru dari remote (kerja dari banyak mesin) |
| `/project` | Info project aktif |
| `/cancel` | Batalkan tugas berjalan |
| `/reset` | Hapus riwayat percakapan |
| `/menu` | Daftarkan ulang menu `/` (kalau tidak muncul) |
| `/tutup` | Tutup tombol menu di bawah kolom ketik |
| `/help` | Bantuan |

### Menu `/` di Telegram

Daftar perintah di atas otomatis didaftarkan ke Telegram saat bot start
(`setMyCommands` untuk chat pribadi, grup, dan admin grup, plus tombol menu
biru di kiri bawah). Sumber daftarnya ada di `src/services/menu.js`
(`BOT_COMMANDS`) — kalau menambah `bot.command(...)` baru, tambahkan juga di
sana supaya muncul di menu.

Pendaftaran dilakukan per scope: kalau satu scope gagal (mis. jaringan), scope
lain tetap didaftarkan. Kalau saat start semuanya gagal, bot mencoba ulang
otomatis di background (5x, jeda 10 detik) tanpa menahan bot menerima pesan.

Ceklist kalau menu `/` belum kelihatan:

1. **Pastikan kode terbaru benar-benar jalan** — setelah `git pull`, jalankan
   `pm2 restart kizora-agent`. Bot yang masih proses lama tidak akan
   mendaftarkan menu baru.
2. Lihat log startup: harus ada `✅ Menu command terdaftar`. Kalau ada
   `⚠️ Menu command gagal didaftarkan`, baca baris `[menu] ...` di atasnya —
   di situ tertulis scope mana yang gagal dan pesan error dari Telegram.
3. Kirim `/menu` di chat: bot mendaftarkan ulang dan membalas status per
   scope (kalau gagal, error-nya ikut ditampilkan) + tombol menu inline sebagai
   jalan pintas.
4. Tutup lalu buka lagi chat (Telegram meng-cache daftar menu per klien).
5. Jangan jalankan dua instance bot dengan token yang sama — keduanya berebut
   `getUpdates` dan perilakunya jadi tidak konsisten.

## Cara kerja agent

```
prompt user
    │
    ▼
┌──────────────────────────────┐
│  LLM (base URL + modelmu)    │◄──── tool results
│  + 8 tools (file/cmd/git)    │
└──────────┬───────────────────┘
           │ tool_call?
     ┌─────┴─────┐
     ▼           ▼
  ada tools   tidak ada
     │           │
     ▼           ▼
 eksekusi    jawaban final
 (ASK:       ke user
  konfirmasi)  │
     │           ▼
     └────► auto-push (kalau ON)
```

- Semua path tool dikunci di dalam workspace project (path traversal ditolak)
- Output command dipotong 6000 char, file dibaca maks 200KB
- Batas 25 iterasi per prompt (bisa diubah via env)

## Struktur project

```
telegram-agent/
├── src/
│   ├── index.js               # entry point
│   ├── config.js              # env config
│   ├── storage.js             # state per-user (data/state.json)
│   ├── bot.js                 # wiring bot + whitelist
│   ├── handlers/
│   │   ├── commands.js        # /settings /connect /repos /mode ...
│   │   ├── callbacks.js       # inline buttons (repo, approve, mode)
│   │   └── messages.js        # pesan biasa = prompt
│   ├── services/
│   │   ├── llm.js             # client OpenAI-compatible
│   │   ├── github.js          # Octokit: list repo, validasi token
│   │   ├── git.js             # clone/pull, commit+push
│   │   └── agent.js           # agentic loop + approval mode ASK
│   ├── tools/
│   │   ├── definitions.js     # schema tool untuk LLM
│   │   └── executor.js        # eksekusi tool (aman, path-locked)
│   └── utils/text.js          # chunking Telegram, deskripsi aksi
├── test/smoke.mjs             # smoke test (tanpa token)
├── .env.example
└── package.json
```

Folder `data/` (state) dan `workspace/` (repo hasil clone) otomatis dibuat saat runtime dan sudah di-`.gitignore`.

## Deploy di VPS (Ubuntu 22.04/24.04)

### 1. SSH ke VPS

```bash
ssh root@IP_VPS
```

### 2. Install dependency sistem

```bash
apt update && apt install -y git curl
```

### 3. Install Node.js 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node -v   # harus v22.x
```

### 4. Clone & setup project

```bash
cd /opt
git clone https://github.com/igustiawan/kizora_code.git
cd kizora_code/telegram-agent
cp .env.example .env
nano .env
```

Isi minimal di `.env`:

```
TELEGRAM_BOT_TOKEN=token_dari_botfather
ALLOWED_TELEGRAM_IDS=telegram_user_id_kamu
```

Amankan file env (berisi token):

```bash
chmod 600 .env
```

### 5. Konfigurasi git (WAJIB — sering terlupa)

Bot menjalankan `git commit` di workspace project, jadi VPS butuh identitas git. Tanpa ini, auto-commit/auto-push akan gagal:

```bash
git config --global user.name "Kizora Agent"
git config --global user.email "agent@kizora.local"
```

### 6. Install dependencies & tes jalan

```bash
npm install
npm start
```

Kalau log muncul `Bot @namabot siap. Menunggu pesan...`, bot sudah jalan. Stop dulu dengan `Ctrl+C`.

Setelah bot hidup, setup dari Telegram seperti biasa: `/settings` (base URL/token/model LLM) → `/connect <github_token>` → `/repos` → pilih project. Setting ini tersimpan di `data/state.json` di VPS.

### 7. Jalankan 24/7 dengan PM2

```bash
npm install -g pm2
pm2 start src/index.js --name kizora-agent
pm2 save
pm2 startup    # jalankan command yang muncul di output-nya
```

Perintah PM2 harian:

```bash
pm2 status                  # cek status semua proses
pm2 logs kizora-agent       # lihat log realtime
pm2 restart kizora-agent    # restart setelah update
pm2 stop kizora-agent       # stop
```

### 8. Update ke versi baru

```bash
cd /opt/kizora_code
git pull
cd telegram-agent
npm install
pm2 restart kizora-agent
```

### Alternatif: systemd (tanpa PM2)

Kalau tidak mau pakai PM2, buat service file:

```bash
nano /etc/systemd/system/kizora-agent.service
```

Isi:

```ini
[Unit]
Description=Kizora Telegram Agent
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/kizora_code/telegram-agent
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Aktifkan:

```bash
systemctl daemon-reload
systemctl enable --now kizora-agent
systemctl status kizora-agent
journalctl -u kizora-agent -f   # lihat log
```

### Catatan keamanan VPS

- Bot mengeksekusi shell command berdasarkan output LLM — jangan bagikan token bot atau akses VPS-nya
- Selalu isi `ALLOWED_TELEGRAM_IDS` supaya hanya user kamu yang bisa pakai
- Token LLM & GitHub disimpan plaintext di `data/state.json` — batasi akses file itu (`chmod 600 data/state.json`)

## Testing

```bash
npm run smoke
```

Menjalankan 36 pengecekan: list/read/write/edit file, penolakan path traversal, run command, git init/commit/push ke bare repo lokal, util teks, serta pendaftaran menu (validasi command, isolasi error per scope, tombol fallback). Tidak butuh token apa pun.

## Catatan keamanan

- Bot ini **mengeksekusi command shell dan menulis file** berdasarkan output LLM — jalankan di mesin/container yang kamu kontrol, jangan expose ke publik
- Simpan `.env` dan `data/state.json` dengan aman — berisi token LLM & GitHub dalam bentuk plaintext
- Pakai mode `ASK` (default) kalau ingin review tiap aksi; `FULL` hanya untuk workspace yang kamu percaya
- Set `ALLOWED_TELEGRAM_IDS` kalau bot tidak cuma untukmu
