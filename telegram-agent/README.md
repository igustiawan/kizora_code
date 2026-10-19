# Kizora Telegram Agent

Bot Telegram coding-agent: konek GitHub, pilih project, lalu kirim prompt — agent membaca/menulis file, menjalankan command, commit & push, semuanya dari chat Telegram.

## Fitur

- **Setting LLM OpenAI-compatible** — base URL, token, model (OpenAI, OpenRouter, DeepSeek, Groq, Ollama, vLLM, dll)
- **Konek GitHub** — validasi token, list repo, clone/pull otomatis ke workspace lokal
- **Agentic loop** — LLM pakai tools: `list_files`, `read_file`, `write_file`, `edit_file`, `run_command`, `git_status`, `git_commit`, `git_push`
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
| `/settings` | Lihat & ubah setting (tombol interaktif) |
| `/setbase <url>` | Set base URL LLM |
| `/settoken <token>` | Set token LLM |
| `/setmodel <nama>` | Set model |
| `/mode full\|ask` | Mode akses |
| `/autopush on\|off` | Auto commit+push setelah selesai |
| `/connect <token>` | Konek GitHub |
| `/repos` | Pilih project |
| `/project` | Info project aktif |
| `/cancel` | Batalkan tugas berjalan |
| `/reset` | Hapus riwayat percakapan |
| `/help` | Bantuan |

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

## Testing

```bash
npm run smoke
```

Menjalankan 23 pengecekan: list/read/write/edit file, penolakan path traversal, run command, git init/commit/push ke bare repo lokal, dan util teks. Tidak butuh token apa pun.

## Catatan keamanan

- Bot ini **mengeksekusi command shell dan menulis file** berdasarkan output LLM — jalankan di mesin/container yang kamu kontrol, jangan expose ke publik
- Simpan `.env` dan `data/state.json` dengan aman — berisi token LLM & GitHub dalam bentuk plaintext
- Pakai mode `ASK` (default) kalau ingin review tiap aksi; `FULL` hanya untuk workspace yang kamu percaya
- Set `ALLOWED_TELEGRAM_IDS` kalau bot tidak cuma untukmu
