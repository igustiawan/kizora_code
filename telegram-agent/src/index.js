import { CONFIG } from './config.js';
import { loadState } from './storage.js';
import { createBot } from './bot.js';
import { registerBotMenu, registerBotMenuDetailed } from './services/menu.js';
import { waitForPredecessor } from './utils/restart.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Kalau pendaftaran menu saat startup gagal (mis. jaringan VPS bermasalah
 * tepat saat boot), coba lagi di background tanpa menahan bot.start().
 */
async function retryMenuInBackground(api, attempts = 5, delayMs = 10_000) {
  for (let i = 1; i <= attempts; i++) {
    await sleep(delayMs);
    const detail = await registerBotMenuDetailed(api);
    if (detail.ok) {
      console.log(`✅ Menu command terdaftar (percobaan ulang ke-${i}).`);
      return;
    }
  }
  console.warn(
    '[menu] masih gagal setelah percobaan ulang. Kirim /menu dari Telegram untuk mencoba lagi.'
  );
}

async function main() {
  if (!CONFIG.telegramToken) {
    console.error(
      'TELEGRAM_BOT_TOKEN belum diset.\n' +
        'Copy .env.example jadi .env, isi token dari @BotFather, lalu jalankan lagi.'
    );
    process.exit(1);
  }

  loadState();

  const bot = createBot();

  // Safety net: pastikan error tak menghentikan polling
  bot.catch((err) => {
    console.error(`[bot error] ${err.ctx?.update?.update_id ?? '?'}:`, err.error);
  });

  const me = await bot.api.getMe();
  console.log(`Bot @${me.username} siap. Menunggu pesan...`);

  // Daftarkan menu "/" ke Telegram (sekali saat start)
  const menuOk = await registerBotMenu(bot.api);
  console.log(
    menuOk
      ? '✅ Menu command terdaftar (cek tombol Menu / ketik /)'
      : '⚠️ Menu command gagal didaftarkan, bot tetap jalan. Lihat log [menu] di atas — coba /menu lagi nanti.'
  );

  if (!menuOk) {
    // jangan di-await: bot harus tetap bisa menerima pesan
    void retryMenuInBackground(bot.api);
  }

  // Kalau proses ini hasil respawn (restart tanpa supervisor), tunggu proses
  // lama berhenti polling Telegram dulu — dua proses polling = 409 Conflict
  // dan grammY akan melempar error.
  await waitForPredecessor();

  await bot.start();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
