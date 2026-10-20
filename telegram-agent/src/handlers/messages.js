import { getUser, saveState } from '../storage.js';
import { runAgent } from '../services/agent.js';
import { createSkill } from '../services/skills.js';
import { replyMenuKeyboard, CLOSE_MENU_TEXT, offerAttach } from './commands.js';

export function registerMessageHandlers(bot) {
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    const user = getUser(ctx.from.id);

    // Command tidak dikenal -> tampilkan tombol menu lagi
    if (text.startsWith('/')) {
      return ctx.reply('Perintah tidak dikenal. Ketik /help atau pakai tombol di bawah.', {
        reply_markup: replyMenuKeyboard()
      });
    }

    // Tombol "Tutup Menu" dari reply keyboard. Dicek SEBELUM wizard setting
    // supaya teksnya tidak terkonsumsi sebagai nilai setting yang sedang
    // menunggu input user.
    if (text.trim() === CLOSE_MENU_TEXT) {
      return ctx.reply('✅ Tombol menu ditutup. Ketik /menu kalau mau memunculkan lagi.', {
        reply_markup: { remove_keyboard: true }
      });
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

    // Wizard skill: pesan berikutnya dianggap isi skill yang sedang dibuat
    if (user.pendingSkill?.step === 'content') {
      const name = user.pendingSkill.name;
      user.pendingSkill = null;
      try {
        const { skill, updated } = createSkill(user, { name, content: text });
        saveState();
        // Setelah tersimpan, langsung tawarkan mau dipasang ke project mana.
        await offerAttach(ctx, user, skill, `✅ Skill "${skill.name}" ${updated ? 'diperbarui' : 'disimpan'}.`);
      } catch (err) {
        await ctx.reply(`❌ ${err.message}`);
      }
      return;
    }

    // Selain itu: pesan adalah prompt untuk agent
    await runAgent(ctx, user, text);
  });
}
