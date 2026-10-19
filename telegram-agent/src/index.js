import { CONFIG } from './config.js';
import { loadState } from './storage.js';
import { createBot } from './bot.js';

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

  await bot.start();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
