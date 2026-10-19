import { getUser, saveState } from '../storage.js';
import { getAuthenticatedLogin, listRepos } from '../services/github.js';
import { cloneOrPullRepo } from '../services/git.js';
import { testConnection } from '../services/llm.js';
import { cancelPendingApprovals } from '../services/agent.js';
import { maskToken } from '../utils/text.js';

const HELP_TEXT = [
  '📖 Daftar perintah:',
  '',
  '/settings — lihat & ubah setting (tombol interaktif)',
  '/setbase <url> — set base URL LLM (cth: https://api.openai.com/v1)',
  '/settoken <token> — set token LLM',
  '/setmodel <nama> — set model (cth: gpt-4o, deepseek-chat)',
  '/mode full|ask — mode akses: full = langsung jalan, ask = konfirmasi dulu',
  '/autopush on|off — auto commit+push setelah agent selesai',
  '',
  '/connect <github_token> — konek akun GitHub',
  '/repos — pilih project (auto clone/pull)',
  '/project — info project aktif',
  '',
  '/cancel — batalkan tugas yang sedang jalan',
  '/reset — hapus riwayat percakapan',
  '/help — tampilkan bantuan ini',
  '',
  'Setelah setup selesai, kirim pesan biasa = prompt untuk agent.'
].join('\n');

function settingsKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🌐 Base URL', callback_data: 'set:base' },
        { text: '🔑 Token', callback_data: 'set:token' },
        { text: '🧠 Model', callback_data: 'set:model' }
      ],
      [
        { text: '⚙️ Mode Akses', callback_data: 'menu:mode' },
        { text: '🚀 Auto-push', callback_data: 'menu:autopush' }
      ],
      [
        { text: '🐙 GitHub', callback_data: 'menu:github' },
        { text: '📁 Pilih Project', callback_data: 'menu:repos' }
      ],
      [{ text: '🧪 Test Koneksi LLM', callback_data: 'test:llm' }]
    ]
  };
}

async function showSettings(ctx, user) {
  const modeLabel = user.mode === 'full' ? 'FULL (langsung jalan)' : 'ASK (konfirmasi dulu)';
  const text = [
    '⚙️ Setting saat ini',
    '',
    `LLM Base URL : ${user.llm.baseUrl || '(belum diset)'}`,
    `LLM Token    : ${maskToken(user.llm.token)}`,
    `LLM Model    : ${user.llm.model || '(belum diset)'}`,
    '',
    `Mode akses   : ${modeLabel}`,
    `Auto-push    : ${user.autoPush ? 'ON' : 'OFF'}`,
    '',
    `GitHub       : ${user.github.username ? '@' + user.github.username : '(belum connect)'}`,
    `Project      : ${user.selectedRepo || '(belum dipilih)'}`
  ].join('\n');
  await ctx.reply(text, { reply_markup: settingsKeyboard() });
}

export function registerCommandHandlers(bot) {
  bot.command('start', async (ctx) => {
    await ctx.reply(
      [
        '👋 Halo! Aku coding-agent bot.',
        '',
        'Alur setup:',
        '1. /settings — atur Base URL, Token, Model LLM',
        '2. /connect <github_token> — konek GitHub',
        '3. /repos — pilih project (auto clone)',
        '4. Kirim prompt apa saja — agent kerja di project itu',
        '',
        'Ketik /help untuk daftar lengkap.'
      ].join('\n')
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(HELP_TEXT);
  });

  bot.command('settings', async (ctx) => {
    await showSettings(ctx, getUser(ctx.from.id));
  });

  bot.command('setbase', async (ctx) => {
    const value = (ctx.match || '').trim();
    if (!value) return ctx.reply('Pakai: /setbase https://api.openai.com/v1');
    const user = getUser(ctx.from.id);
    user.llm.baseUrl = value.replace(/\/+$/, '');
    saveState();
    await ctx.reply(`✅ Base URL diset: ${user.llm.baseUrl}`);
  });

  bot.command('settoken', async (ctx) => {
    const value = (ctx.match || '').trim();
    if (!value) return ctx.reply('Pakai: /settoken sk-xxxx');
    const user = getUser(ctx.from.id);
    user.llm.token = value;
    saveState();
    await ctx.reply(`✅ Token diset: ${maskToken(value)}`);
  });

  bot.command('setmodel', async (ctx) => {
    const value = (ctx.match || '').trim();
    if (!value) return ctx.reply('Pakai: /setmodel gpt-4o');
    const user = getUser(ctx.from.id);
    user.llm.model = value;
    saveState();
    await ctx.reply(`✅ Model diset: ${value}`);
  });

  bot.command('mode', async (ctx) => {
    const value = (ctx.match || '').trim().toLowerCase();
    const user = getUser(ctx.from.id);
    if (value === 'full' || value === 'ask') {
      user.mode = value;
      saveState();
      return ctx.reply(
        `✅ Mode akses: ${value === 'full' ? 'FULL (semua aksi langsung jalan)' : 'ASK (konfirmasi dulu tiap aksi)'}`
      );
    }
    await ctx.reply('Pakai: /mode full  atau  /mode ask', {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '⚡ FULL', callback_data: 'mode:full' },
            { text: '🛡️ ASK', callback_data: 'mode:ask' }
          ]
        ]
      }
    });
  });

  bot.command('autopush', async (ctx) => {
    const value = (ctx.match || '').trim().toLowerCase();
    const user = getUser(ctx.from.id);
    if (value === 'on' || value === 'off') {
      user.autoPush = value === 'on';
      saveState();
      return ctx.reply(`✅ Auto-push: ${user.autoPush ? 'ON' : 'OFF'}`);
    }
    await ctx.reply('Pakai: /autopush on  atau  /autopush off', {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ ON', callback_data: 'autopush:on' },
            { text: '❌ OFF', callback_data: 'autopush:off' }
          ]
        ]
      }
    });
  });

  bot.command('connect', async (ctx) => {
    const token = (ctx.match || '').trim();
    if (!token) {
      return ctx.reply(
        'Pakai: /connect ghp_xxxx\n\n' +
          'Buat token di https://github.com/settings/tokens (butuh scope `repo`).'
      );
    }
    const status = await ctx.reply('🔌 Memvalidasi token GitHub...');
    try {
      const login = await getAuthenticatedLogin(token);
      const user = getUser(ctx.from.id);
      user.github.token = token;
      user.github.username = login;
      saveState();
      await ctx.api.editMessageText(
        ctx.chat.id,
        status.message_id,
        `✅ Terkonek sebagai @${login}.\n\nSekarang /repos untuk pilih project.`
      );
    } catch (err) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        status.message_id,
        `❌ Token tidak valid: ${err.message}`
      );
    }
  });

  bot.command('repos', async (ctx) => {
    const user = getUser(ctx.from.id);
    if (!user.github.token) {
      return ctx.reply('⚠️ GitHub belum dikonek. Pakai /connect <github_token> dulu.');
    }
    const status = await ctx.reply('📡 Mengambil daftar repo...');
    try {
      const repos = await listRepos(user.github.token, 30);
      if (!repos.length) {
        return ctx.api.editMessageText(ctx.chat.id, status.message_id, 'Tidak ada repo yang bisa diakses.');
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
  });

  bot.command('project', async (ctx) => {
    const user = getUser(ctx.from.id);
    if (!user.selectedRepo) {
      return ctx.reply('Belum ada project aktif. Pakai /repos untuk pilih.');
    }
    const lines = [
      `📁 Project aktif: ${user.selectedRepo}`,
      `📂 Workspace: ${user.workspace}`,
      `🌿 Mode: ${user.mode === 'full' ? 'FULL' : 'ASK'} | Auto-push: ${user.autoPush ? 'ON' : 'OFF'}`,
      `💬 Riwayat: ${user.history.length} pesan`
    ];
    await ctx.reply(lines.join('\n'));
  });

  bot.command('cancel', async (ctx) => {
    const user = getUser(ctx.from.id);
    if (!user.running) {
      return ctx.reply('Tidak ada tugas yang berjalan.');
    }
    user.cancelRequested = true;
    cancelPendingApprovals(ctx.from.id);
    saveState();
    await ctx.reply('🛑 Membatalkan...');
  });

  bot.command('reset', async (ctx) => {
    const user = getUser(ctx.from.id);
    user.history = [];
    saveState();
    await ctx.reply('🧹 Riwayat percakapan dihapus.');
  });
}
