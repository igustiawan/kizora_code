import { Bot } from 'grammy';
import { CONFIG } from './config.js';
import { isAllowed } from './storage.js';
import { registerCommandHandlers } from './handlers/commands.js';
import { registerCallbackHandlers } from './handlers/callbacks.js';
import { registerMessageHandlers } from './handlers/messages.js';

export function createBot() {
  const bot = new Bot(CONFIG.telegramToken);

  // Whitelist user (kalau ALLOWED_TELEGRAM_IDS diset)
  bot.use(async (ctx, next) => {
    if (ctx.from && !isAllowed(ctx.from.id)) {
      await ctx.reply('⛔ Kamu tidak punya akses ke bot ini.');
      return;
    }
    await next();
  });

  registerCommandHandlers(bot);
  registerCallbackHandlers(bot);
  registerMessageHandlers(bot);

  return bot;
}
