import { getUser, saveState } from '../storage.js';
import { settleApproval } from '../services/agent.js';
import { cloneOrPullRepo } from '../services/git.js';
import { listRepos } from '../services/github.js';
import { testConnection } from '../services/llm.js';
import {
  findSkill,
  attachSkill,
  detachSkill,
  deleteSkill,
  projectChoices
} from '../services/skills.js';
import { showSettings, showSkills } from './commands.js';

const INPUT_LABELS = {
  base: 'Base URL LLM (contoh: https://api.openai.com/v1)',
  token: 'Token API LLM',
  model: 'nama model (contoh: gpt-4o, deepseek-chat, claude-sonnet-4-5)'
};

function modeKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '⚡ FULL (langsung jalan)', callback_data: 'mode:full' },
        { text: '🛡️ ASK (konfirmasi dulu)', callback_data: 'mode:ask' }
      ]
    ]
  };
}

function autopushKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '✅ ON', callback_data: 'autopush:on' },
        { text: '❌ OFF', callback_data: 'autopush:off' }
      ]
    ]
  };
}

function autorestartKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '✅ ON', callback_data: 'autorestart:on' },
        { text: '❌ OFF', callback_data: 'autorestart:off' }
      ]
    ]
  };
}

export function registerCallbackHandlers(bot) {
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const user = getUser(ctx.from.id);

    // --- wizard setting: minta user kirim nilai lewat chat ---
    if (data.startsWith('set:')) {
      const field = data.slice(4); // base | token | model
      if (!INPUT_LABELS[field]) {
        return ctx.answerCallbackQuery({ text: 'Field tidak dikenal' });
      }
      user.pendingInput = field;
      saveState();
      await ctx.answerCallbackQuery();
      return ctx.reply(`Kirim ${INPUT_LABELS[field]} sekarang:`);
    }

    // --- menu tampilan ---
    if (data === 'menu:settings') {
      await ctx.answerCallbackQuery();
      return showSettings(ctx, user);
    }
    if (data === 'menu:mode') {
      await ctx.answerCallbackQuery();
      return ctx.reply('Pilih mode akses:', { reply_markup: modeKeyboard() });
    }
    if (data === 'menu:autopush') {
      await ctx.answerCallbackQuery();
      return ctx.reply('Auto-push setelah agent selesai?', { reply_markup: autopushKeyboard() });
    }
    if (data === 'menu:autorestart') {
      await ctx.answerCallbackQuery();
      return ctx.reply('Auto sinkron kode bot + restart setelah agent selesai?', {
        reply_markup: autorestartKeyboard()
      });
    }
    if (data === 'menu:github') {
      await ctx.answerCallbackQuery();
      return ctx.reply(
        user.github.token
          ? `GitHub sudah terkonek sebagai @${user.github.username}.\nGanti token: /connect <token_baru>`
          : 'Konek GitHub dengan: /connect <github_token>'
      );
    }
    if (data === 'menu:skills') {
      await ctx.answerCallbackQuery();
      return showSkills(ctx, user);
    }
    if (data === 'menu:repos') {
      await ctx.answerCallbackQuery();
      if (!user.github.token) {
        return ctx.reply('⚠️ Konek GitHub dulu: /connect <github_token>');
      }
      const status = await ctx.reply('📡 Mengambil daftar repo...');
      try {
        const repos = await listRepos(user.github.token, 30);
        if (!repos.length) {
          return ctx.api.editMessageText(ctx.chat.id, status.message_id, 'Tidak ada repo.');
        }
        const keyboard = repos.map((r) => [
          {
            text: `${r.private ? '🔒' : '🌐'} ${r.full_name}`,
            callback_data: `repo:${r.full_name}`
          }
        ]);
        await ctx.api.editMessageText(ctx.chat.id, status.message_id, '📁 Pilih project:', {
          reply_markup: { inline_keyboard: keyboard }
        });
      } catch (err) {
        await ctx.api.editMessageText(
          ctx.chat.id,
          status.message_id,
          `❌ Gagal mengambil repo: ${err.message}`
        );
      }
      return;
    }

    // --- skill library: add | attach:<id> | detach:<id> | del:<id> | pick:<id>:<n> ---
    if (data.startsWith('skill:')) {
      const action = data.slice(6);

      if (action === 'add') {
        await ctx.answerCallbackQuery();
        return ctx.reply('Ketik: /skill add <nama skill>\nLalu kirim isi instruksinya.');
      }

      if (action === 'skip') {
        // User memilih "Nanti saja" saat ditawari pasang skill ke project.
        await ctx.answerCallbackQuery({ text: 'Dilewati' });
        try {
          return await ctx.editMessageText(
            'ℹ️ Skill tersimpan tanpa dipasang. Pasang nanti lewat /skills atau /skill attach <id>.'
          );
        } catch {
          return ctx.reply(
            'ℹ️ Skill tersimpan tanpa dipasang. Pasang nanti lewat /skills atau /skill attach <id>.'
          );
        }
      }

      if (action.startsWith('attach:')) {
        const id = action.slice(7);
        const skill = findSkill(user, id);
        if (!skill) {
          await ctx.answerCallbackQuery({ text: 'Skill tidak ditemukan' });
          return ctx.reply('❌ Skill tidak ditemukan (mungkin sudah dihapus). Daftar: /skills');
        }
        const choices = projectChoices(user);
        if (!choices.length) {
          await ctx.answerCallbackQuery();
          return ctx.reply('⚠️ Belum ada project. Pilih dulu: /repos');
        }
        // Lebih dari satu project -> tampilkan pilihan dulu
        if (choices.length > 1) {
          await ctx.answerCallbackQuery();
          return ctx.reply(`Pasang "${skill.name}" ke project mana?`, {
            reply_markup: {
              inline_keyboard: choices.map((repo, i) => [
                { text: repo, callback_data: `skill:pick:${skill.id}:${i}` }
              ])
            }
          });
        }
        const r = attachSkill(user, skill.id, choices[0]);
        saveState();
        await ctx.answerCallbackQuery({ text: r.already ? 'Sudah terpasang' : 'Dipasang' });
        return ctx.reply(
          r.ok
            ? `✅ "${skill.name}" ${r.already ? 'sudah ' : ''}terpasang di ${r.project}.`
            : `❌ ${r.reason}`
        );
      }

      if (action.startsWith('pick:')) {
        const rest = action.slice(5);
        const sep = rest.lastIndexOf(':');
        const id = rest.slice(0, sep);
        const idx = Number(rest.slice(sep + 1));
        const skill = findSkill(user, id);
        const repo = projectChoices(user)[idx];
        if (!skill || !repo) {
          await ctx.answerCallbackQuery({ text: 'Pilihan kedaluwarsa' });
          return ctx.reply('❌ Pilihan tidak valid. Coba lagi: /skills');
        }
        const r = attachSkill(user, skill.id, repo);
        saveState();
        await ctx.answerCallbackQuery({ text: 'Dipasang' });
        return ctx.reply(`✅ "${skill.name}" terpasang di ${repo}.`);
      }

      if (action.startsWith('detach:')) {
        const id = action.slice(7);
        const skill = findSkill(user, id);
        if (!skill) {
          await ctx.answerCallbackQuery({ text: 'Skill tidak ditemukan' });
          return ctx.reply('❌ Skill tidak ditemukan. Daftar: /skills');
        }
        const r = detachSkill(user, skill.id, user.selectedRepo || '');
        saveState();
        await ctx.answerCallbackQuery({ text: 'Dilepas' });
        return ctx.reply(
          r.ok
            ? `✅ "${skill.name}" dilepas${r.project ? ` dari ${r.project}` : ' dari semua project'}.`
            : `❌ ${r.reason}`
        );
      }

      if (action.startsWith('del:')) {
        const id = action.slice(4);
        const skill = findSkill(user, id);
        if (!skill) {
          await ctx.answerCallbackQuery({ text: 'Skill tidak ditemukan' });
          return ctx.reply('❌ Skill tidak ditemukan. Daftar: /skills');
        }
        deleteSkill(user, skill.id);
        saveState();
        await ctx.answerCallbackQuery({ text: 'Dihapus' });
        return ctx.reply(`🗑️ Skill "${skill.name}" dihapus.`);
      }

      await ctx.answerCallbackQuery({ text: 'Aksi skill tidak dikenal' });
      return;
    }

    // --- test koneksi LLM ---
    if (data === 'test:llm') {
      await ctx.answerCallbackQuery({ text: 'Mengetes...' });
      if (!user.llm.baseUrl || !user.llm.token || !user.llm.model) {
        return ctx.reply('⚠️ Lengkapi Base URL, Token, dan Model dulu.');
      }
      try {
        const reply = await testConnection(user.llm);
        return ctx.reply(`✅ Koneksi LLM OK. Balasan model: "${String(reply).slice(0, 200)}"`);
      } catch (err) {
        return ctx.reply(`❌ Koneksi LLM gagal: ${err.message}`);
      }
    }

    // --- set mode / autopush ---
    if (data.startsWith('mode:')) {
      user.mode = data.slice(5) === 'full' ? 'full' : 'ask';
      saveState();
      await ctx.answerCallbackQuery({ text: `Mode: ${user.mode}` });
      return ctx.reply(
        user.mode === 'full'
          ? '⚡ Mode FULL: semua aksi agent langsung dijalankan tanpa konfirmasi.'
          : '🛡️ Mode ASK: agent minta konfirmasi sebelum menulis file, menjalankan command, commit, atau push.'
      );
    }
    if (data.startsWith('autopush:')) {
      user.autoPush = data.slice(9) === 'on';
      saveState();
      await ctx.answerCallbackQuery({ text: `Auto-push: ${user.autoPush ? 'ON' : 'OFF'}` });
      return ctx.reply(
        user.autoPush
          ? '🚀 Auto-push ON: setelah agent selesai, sisa perubahan langsung di-commit & push.'
          : 'Auto-push OFF: perubahan tidak di-push otomatis.'
      );
    }
    if (data.startsWith('autorestart:')) {
      user.autoRestart = data.slice(13) === 'on';
      saveState();
      await ctx.answerCallbackQuery({ text: `Auto-restart: ${user.autoRestart ? 'ON' : 'OFF'}` });
      return ctx.reply(
        user.autoRestart
          ? '♻️ Auto-restart ON: setelah agent selesai, kode bot disinkron dari repo lalu bot restart otomatis.'
          : 'Auto-restart OFF: perubahan kode bot perlu /sync manual.'
      );
    }

    // --- pilih repo: clone/pull lalu jadikan project aktif ---
    if (data.startsWith('repo:')) {
      const fullName = data.slice(5);
      await ctx.answerCallbackQuery({ text: 'Menyiapkan repo...' });
      const status = await ctx.reply(`📥 Clone/pull ${fullName}...`);
      try {
        const { path, pulled } = await cloneOrPullRepo(fullName, user.github.token);
        user.selectedRepo = fullName;
        user.workspace = path;
        // Catat project yang pernah dipakai (dipakai /skill attach & projectChoices)
        if (!Array.isArray(user.knownProjects)) user.knownProjects = [];
        if (!user.knownProjects.includes(fullName)) user.knownProjects.push(fullName);
        user.history = [];
        saveState();
        await ctx.api.editMessageText(
          ctx.chat.id,
          status.message_id,
          [
            `✅ Project aktif: ${fullName}`,
            `📂 Workspace: ${path}`,
            pulled ? '(git pull dilakukan)' : '(clone baru)',
            '',
            'Kirim prompt apa saja untuk mulai.'
          ].join('\n')
        );
      } catch (err) {
        await ctx.api.editMessageText(
          ctx.chat.id,
          status.message_id,
          `❌ Gagal clone/pull: ${err.message}`
        );
      }
      return;
    }

    // --- approval aksi agent (mode ASK) ---
    if (data.startsWith('approve:') || data.startsWith('reject:')) {
      const approved = data.startsWith('approve:');
      const nonce = data.slice(approved ? 8 : 7);
      const settled = settleApproval(ctx.from.id, nonce, approved);
      await ctx.answerCallbackQuery({
        text: settled ? (approved ? '✅ Dijalankan' : '❌ Ditolak') : 'Kedaluwarsa'
      });
      try {
        const original = ctx.callbackQuery.message?.text || '(aksi)';
        await ctx.editMessageText(`${original}\n\n→ ${approved ? '✅ DISETUJUI' : '❌ DITOLAK'}`);
      } catch {
        // pesan asli mungkin sudah tidak bisa di-edit — abaikan
      }
      return;
    }

    await ctx.answerCallbackQuery();
  });
}
