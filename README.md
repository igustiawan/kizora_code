# kizora_code

Koleksi project kode milik [@igustiawan](https://github.com/igustiawan).

## Isi repo

| Project | Deskripsi |
|---|---|
| [`telegram-agent/`](telegram-agent/) | Bot Telegram coding-agent: konek GitHub, pilih project, prompt LLM langsung dari chat, mode akses full/ask, dan auto-push ke git. |

## telegram-agent (highlight)

Bot Telegram yang menjalankan agentic coding loop di project GitHub pilihanmu:

- **Setting LLM OpenAI-compatible** — base URL, token, model (OpenAI, OpenRouter, DeepSeek, Groq, Ollama, dll)
- **Konek GitHub** — validasi token, list repo, clone/pull otomatis
- **Prompt dari chat** — agent membaca/menulis file, menjalankan command, commit & push
- **Mode akses** — `ASK` (konfirmasi tiap aksi via tombol) atau `FULL` (langsung jalan)
- **Auto-push** — sisa perubahan otomatis di-commit & push setelah agent selesai

Setup singkat:

```bash
cd telegram-agent
cp .env.example .env   # isi TELEGRAM_BOT_TOKEN dari @BotFather
npm install
npm start
```

Lalu di Telegram: `/settings` → isi base URL/token/model → `/connect <github_token>` → `/repos` → pilih project → kirim prompt.

Dokumentasi lengkap: [telegram-agent/README.md](telegram-agent/README.md)
