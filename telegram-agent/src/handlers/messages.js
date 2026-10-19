import { getUser, saveState } from '../storage.js';
import { runAgent } from '../services/agent.js';

export function registerMessageHandlers(bot) {
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    const user = getUser(ctx.from.id);

    // Command tidak dikenal -> abaikan (sudah ditangani bot.command)
    if (text.startsWith('/')) {
      return ctx.reply('Perintah tidak dikenal. Ketik /help.');
    }

    // Wizard setting: pesan berikutnya dianggap nilai setting
    if (user.pendingInput) {
      const field = user.pendingInput;
      const value = text.trim();
      user.pendingInput = null;

      if (field === 'base') user.llm.baseUrl = value.replace(/\/+$/, '');
      else if (field === 'token') user.llm.token = value;
      else if (field === 'model') user.llm.model = value;

      saveState();
      await ctx.reply(`✅ Tersimpan. Lihat semua setting: /settings`);
      return;
    }

    // Selain itu: pesan adalah prompt untuk agent
    await runAgent(ctx, user, text);
  });
}
