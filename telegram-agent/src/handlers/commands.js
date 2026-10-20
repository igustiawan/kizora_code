import { getUser, saveState } from '../storage.js';
import { getAuthenticatedLogin, listRepos } from '../services/github.js';
import { cloneOrPullRepo } from '../services/git.js';
import { testConnection } from '../services/llm.js';
import { cancelPendingApprovals } from '../services/agent.js';
import { registerBotMenuDetailed, BOT_COMMANDS } from '../services/menu.js';
import { syncAndRestart, checkSyncStatus, RESTART_EXIT_CODE } from '../services/sync.js';
import {
  createSkill,
  deleteSkill,
  attachSkill,
  detachSkill,
  findSkill,
  projectChoices,
  readSkillFromFile,
  previewSkillContent,
  MAX_SKILL_NAME
} from '../services/skills.js';
import { maskToken } from '../utils/text.js';

const HELP_TEXT = [
  '📖 Daftar perintah:',
  '',
  '/start — panduan setup singkat',
  '/settings — lihat & ubah setting (tombol interaktif)',
  '/setbase <url> — set base URL LLM (cth: https://api.openai.com/v1)',
  '/settoken <token> — set token LLM',
  '/setmodel <nama> — set model (cth: gpt-4o, deepseek-chat)',
  '/mode full|ask — mode akses: full = langsung jalan, ask = konfirmasi dulu',
  '/autopush on|off — auto commit+push setelah agent selesai',
  '/autorestart on|off — auto sinkron kode bot + restart setelah agent selesai',
  '',
  '/connect <github_token> — konek akun GitHub',
  '/repos — pilih project (auto clone/pull)',
  '/project — info project aktif',
  '/skills — kelola skill (instruksi khusus per project)',
  '/skill add <nama> — import skill baru (kirim isinya setelah ini)',
  '/skill import <path> — import skill dari file di project aktif',
  '/skill attach <id> — pasang skill ke project pilihan',
  '/skill detach <id> — lepas skill dari project',
  '/skill del <id> — hapus skill',
  '/sync — sinkron kode bot dari repo lalu restart',
  '/restart — restart bot',
  '',
  '/cancel — batalkan tugas yang sedang jalan',
  '/batal — batalkan input yang sedang menunggu (skill/setting)',
  '/reset — hapus riwayat percakapan',
  '/menu — pasang ulang tombol & daftar menu (kalau tak muncul)',
  '/tutup — tutup tombol menu di bawah kolom ketik',
  '/help — tampilkan bantuan ini',
  '',
  'Setelah setup selesai, kirim pesan biasa = prompt untuk agent.',
  'Tombol menu muncul di bawah kolom ketik setiap kali /start, /help, atau /menu.',
  'Tekan tombol ❌ Tutup Menu atau ketik /tutup kalau mau menyembunyikannya.'
].join('\n');

// Diekspor untuk test konsistensi antara teks bantuan dan menu "/" Telegram.
export const HELP_TEXT_FOR_TEST = HELP_TEXT;

export function settingsKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🌐 Base URL', callback_data: 'set:base' },
        { text: '🔑 Token', callback_data: 'set:token' },
        { text: '🧠 Model', callback_data: 'set:model' }
      ],
      [
        { text: '⚙️ Mode Akses', callback_data: 'menu:mode' },
        { text: '🚀 Auto-push', callback_data: 'menu:autopush' },
        { text: '♻️ Auto-restart', callback_data: 'menu:autorestart' }
      ],
      [
        { text: '🐙 GitHub', callback_data: 'menu:github' },
        { text: '📁 Pilih Project', callback_data: 'menu:repos' }
      ],
      [
        { text: '🧠 Skills', callback_data: 'menu:skills' },
        { text: '🧪 Test Koneksi LLM', callback_data: 'test:llm' }
      ]
    ]
  };
}

export async function showSettings(ctx, user) {
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
    `Auto-restart : ${user.autoRestart === false ? 'OFF' : 'ON'}`,
    '',
    `GitHub       : ${user.github.username ? '@' + user.github.username : '(belum connect)'}`,
    `Project      : ${user.selectedRepo || '(belum dipilih)'}`
  ].join('\n');
  await ctx.reply(text, { reply_markup: settingsKeyboard() });
}

/**
 * Tampilan daftar skill (dipakai /skills dan tombol 🧠 Skills di /settings).
 * Setiap skill punya tombol pasang/lepas/hapus.
 */
export async function showSkills(ctx, user) {
  const skills = Array.isArray(user.skills) ? user.skills : [];

  if (!skills.length) {
    return ctx.reply(
      [
        '🧠 Belum ada skill.',
        '',
        'Skill = instruksi khusus yang dipasang ke project (konvensi kode,',
        'cara commit, perintah test, gaya penulisan, dll).',
        '',
        'Tambah: /skill add <nama>',
        'Impor dari file project: /skill import <path>'
      ].join('\n'),
      {
        reply_markup: {
          inline_keyboard: [[{ text: '➕ Tambah Skill', callback_data: 'skill:add' }]]
        }
      }
    );
  }

  const lines = [`🧠 Skill library (${skills.length})`, ''];
  const keyboard = [];

  skills.forEach((s, i) => {
    const attached = (s.projects || []).length
      ? `📌 ${s.projects.join(', ')}`
      : '⚪ belum terpasang';
    lines.push(`${i + 1}. ${s.name} — ${attached}`);
    if (s.description) lines.push(`   ${s.description}`);
    const preview = previewSkillContent(s.content, 120);
    if (preview) lines.push(`   "${preview}"`);
    lines.push('');
    keyboard.push([
      { text: `📌 #${i + 1} Pasang`, callback_data: `skill:attach:${s.id}` },
      { text: '🔓', callback_data: `skill:detach:${s.id}` },
      { text: '🗑️', callback_data: `skill:del:${s.id}` }
    ]);
  });

  keyboard.push([{ text: '➕ Tambah Skill', callback_data: 'skill:add' }]);

  await ctx.reply(lines.join('\n'), { reply_markup: { inline_keyboard: keyboard } });
}

/**
 * Keyboard tombol permanen (reply keyboard) di bawah kolom ketik.
 *
 * Ini yang paling andal: tidak tergantung daftar "/" Telegram (yang di-cache
 * per klien dan hanya muncul di chat pribadi). Isi tombol sengaja berupa teks
 * perintah persis, jadi saat ditekan Telegram mengirim "/settings" dan
 * langsung ditangani bot.command tanpa mapping tambahan.
 */
/**
 * Teks tombol "Tutup Menu" di reply keyboard. Diekspor supaya message
 * handler bisa mengenalinya (tombol reply keyboard dikirim sebagai pesan
 * teks biasa, bukan command).
 */
export const CLOSE_MENU_TEXT = '❌ Tutup Menu';

export const REPLY_MENU_BUTTONS = [
  ['/settings', '/repos'],
  ['/project', '/mode'],
  ['/autopush', '/cancel'],
  ['/help', '/menu'],
  [CLOSE_MENU_TEXT]
];

export function replyMenuKeyboard() {
  return {
    keyboard: REPLY_MENU_BUTTONS.map((row) => row.map((text) => ({ text }))),
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: 'Ketik /help atau kirim prompt untuk agent'
  };
}

/**
 * Menu tombol (inline) — fallback kalau menu "/" bawaan Telegram tidak muncul
 * di klien user (masalah cache klien) atau pendaftaran menu gagal.
 */
export function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '⚙️ Settings', callback_data: 'menu:settings' },
        { text: '⚙️ Mode Akses', callback_data: 'menu:mode' }
      ],
      [
        { text: '🚀 Auto-push', callback_data: 'menu:autopush' },
        { text: '🐙 GitHub', callback_data: 'menu:github' }
      ],
      [
        { text: '📁 Pilih Project', callback_data: 'menu:repos' },
        { text: '🧪 Test LLM', callback_data: 'test:llm' }
      ]
    ]
  };
}

/**
 * Middleware: pastikan tombol menu (reply keyboard) selalu muncul setelah
 * user menjalankan command apa pun, walau command itu sendiri tidak
 * menyertakan reply_markup.
 *
 * Ini menyelesaikan keluhan "tombol menu tidak pernah muncul": user tidak
 * perlu ingat menjalankan /start dulu — cukup satu command apa saja
 * (mis. /settings, /repos, /project), dan tombol di bawah kolom ketik
 * langsung tampil. Command yang memang menentukan reply_markup sendiri
 * (inline keyboard atau remove_keyboard dari /tutup) tidak ditimpa.
 */
export function ensureMenuKeyboardMiddleware() {
  return async (ctx, next) => {
    const text = ctx.message?.text;
    if (typeof text === 'string' && text.startsWith('/') && typeof ctx.reply === 'function') {
      const originalReply = ctx.reply.bind(ctx);
      ctx.reply = (message, extra = {}) =>
        originalReply(message, {
          ...extra,
          // hanya isi kalau command tidak menentukan reply_markup sendiri
          reply_markup: extra.reply_markup ?? replyMenuKeyboard()
        });
    }
    await next();
  };
}

/**
 * Tawarkan pemasangan skill ke project mana.
 *
 * Dipakai setelah /skill add, /skill import, dan /skill attach: user langsung
 * dapat tombol pilih project (bukan harus ingat perintah attach terpisah).
 * Selalu menampilkan tombol pilihan + opsi "Nanti saja" supaya user benar-benar
 * bisa memilih skill ini mau dipasang ke project yang mana.
 */
export async function offerAttach(ctx, user, skill, prefix = '') {
  const head = prefix ? `${prefix}\n\n` : '';
  const choices = projectChoices(user);

  if (!choices.length) {
    return ctx.reply(
      `${head}ℹ️ Belum ada project aktif. Pilih project dulu lewat /repos, ` +
        `lalu pasang skill ini dengan /skill attach ${skill.id}.`
    );
  }

  return ctx.reply(`${head}📌 Pasang "${skill.name}" ke project mana?`, {
    reply_markup: {
      inline_keyboard: [
        ...choices.map((repo, i) => [
          { text: `📌 ${repo}`, callback_data: `skill:pick:${skill.id}:${i}` }
        ]),
        [{ text: '⏭️ Nanti saja', callback_data: 'skill:skip' }]
      ]
    }
  });
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
        'Tombol menu sudah aktif di bawah kolom ketik — tinggal tekan.',
        'Ketik /help untuk daftar lengkap.'
      ].join('\n'),
      // reply keyboard permanen: tombol selalu kelihatan di bawah kolom ketik,
      // tidak tergantung cache daftar "/" di klien Telegram.
      { reply_markup: replyMenuKeyboard() }
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(HELP_TEXT, { reply_markup: mainMenuKeyboard() });
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

  bot.command('autorestart', async (ctx) => {
    const value = (ctx.match || '').trim().toLowerCase();
    const user = getUser(ctx.from.id);
    if (value === 'on' || value === 'off') {
      user.autoRestart = value === 'on';
      saveState();
      return ctx.reply(`✅ Auto-restart: ${user.autoRestart ? 'ON' : 'OFF'}`);
    }
    await ctx.reply('Pakai: /autorestart on  atau  /autorestart off', {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ ON', callback_data: 'autorestart:on' },
            { text: '❌ OFF', callback_data: 'autorestart:off' }
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

  bot.command('sync', async (ctx) => {
    const user = getUser(ctx.from.id);
    if (!user.workspace) {
      return ctx.reply('⚠️ Belum ada project aktif. Pakai /repos dulu.');
    }
    const status = await checkSyncStatus(user.workspace);
    if (!status.ok) {
      return ctx.reply(`⚠️ Gagal memeriksa sinkronisasi: ${status.reason}`);
    }
    if (status.files.length === 0) {
      return ctx.reply('✅ Kode bot sudah sinkron dengan repo. Tidak ada yang perlu di-copy.');
    }
    await ctx.reply(
      [
        `🔄 ${status.files.length} file berbeda dari repo:`,
        ...status.files.slice(0, 10).map((f) => `  • ${f}`),
        status.files.length > 10 ? `  (+${status.files.length - 10} lainnya)` : '',
        '',
        '♻️ Menyinkronkan dan me-restart bot...'
      ]
        .filter(Boolean)
        .join('\n')
    );
    const r = await syncAndRestart({ workspaceRoot: user.workspace });
    if (r.synced) {
      await ctx.reply(
        [
          '✅ Bot ter-restart dengan kode terbaru.',
          `💾 Backup kode lama: ${r.backup ? r.backup.split('/').pop() : '-'}`,
          '⏳ Tunggu beberapa detik, lalu kirim pesan lagi.'
        ].join('\n')
      );
    } else {
      await ctx.reply(`⚠️ Sinkron gagal: ${r.reason}`);
    }
  });

  bot.command('restart', async (ctx) => {
    await ctx.reply('♻️ Me-restart bot...');
    setTimeout(() => process.exit(RESTART_EXIT_CODE), 500);
  });

  bot.command('menu', async (ctx) => {
    // Daftarkan untuk semua scope global + scope chat ini secara eksplisit,
    // supaya chat ini pasti punya menu walau scope lain bermasalah.
    const detail = await registerBotMenuDetailed(ctx.api, BOT_COMMANDS, {
      chatId: ctx.chat?.id
    });

    const lines = detail.ok
      ? [
          '✅ Menu sudah didaftarkan ulang ke Telegram.',
          '',
          'Kalau daftar "/" masih belum muncul di klien ini:',
          '1. tutup lalu buka lagi chat ini (Telegram meng-cache menu),',
          '2. atau langsung pakai tombol di bawah kolom ketik / tombol di pesan ini.',
          '',
          `Total perintah: ${BOT_COMMANDS.length}`,
          'Tekan ❌ Tutup Menu atau /tutup kalau mau menyembunyikan tombol bawah.'
        ]
      : [
          '⚠️ Menu "/" belum berhasil didaftarkan.',
          '',
          ...[...detail.errors, ...detail.failed.map((f) => `${f.scope}: ${f.error}`)].map(
            (e) => `• ${e}`
          ),
          '',
          'Sementara itu pakai tombol di bawah kolom ketik / tombol di pesan ini.',
          'Tekan ❌ Tutup Menu atau /tutup kalau mau menyembunyikan tombol bawah.'
        ];

    // 1) keyboard permanen di bawah kolom ketik (paling andal)
    await ctx.reply(lines.join('\n'), { reply_markup: replyMenuKeyboard() });
    // 2) menu inline sebagai jalan pintas tambahan
    await ctx.reply('📋 Menu cepat:', { reply_markup: mainMenuKeyboard() });
  });

  bot.command('tutup', async (ctx) => {
    // Hapus reply keyboard dari chat ini. Keyboard persisten cuma bisa
    // dilepas dengan remove_keyboard — tidak ada cara lain dari sisi bot.
    await ctx.reply('✅ Tombol menu ditutup. Ketik /menu kalau mau memunculkan lagi.', {
      reply_markup: { remove_keyboard: true }
    });
  });

  bot.command('batal', async (ctx) => {
    // Escape hatch untuk wizard (skill content / setting) yang menggantung.
    const user = getUser(ctx.from.id);
    const had = user.pendingInput || user.pendingSkill;
    user.pendingInput = null;
    user.pendingSkill = null;
    saveState();
    await ctx.reply(had ? '✅ Input dibatalkan.' : 'Tidak ada input yang sedang menunggu.');
  });

  bot.command('skills', async (ctx) => {
    await showSkills(ctx, getUser(ctx.from.id));
  });

  bot.command('skill', async (ctx) => {
    const user = getUser(ctx.from.id);
    const [sub, ...rest] = (ctx.match || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    // /skill add <nama> -> minta isi skill lewat pesan berikutnya
    if (sub === 'add') {
      const name = rest.join(' ').trim();
      if (!name) return ctx.reply('Pakai: /skill add <nama skill>');
      if (name.length > MAX_SKILL_NAME) {
        return ctx.reply(`❌ Nama skill maksimal ${MAX_SKILL_NAME} karakter.`);
      }
      user.pendingSkill = { step: 'content', name };
      saveState();
      return ctx.reply(
        `Kirim isi skill "${name}" sekarang.\n\n` +
          'Tulis instruksi sejelas mungkin (konvensi, aturan, contoh). Teks panjang boleh.\n' +
          'Kirim /batal kalau ingin membatalkan.'
      );
    }

    // /skill import <path> -> ambil isi skill dari file di project aktif
    if (sub === 'import') {
      const path = rest.join(' ').trim();
      if (!path) return ctx.reply('Pakai: /skill import <path file di project aktif>');
      if (!user.workspace) return ctx.reply('⚠️ Belum ada project aktif. Pilih dulu: /repos');
      try {
        const { name, content, path: from } = readSkillFromFile(user.workspace, path);
        const { skill, updated } = createSkill(user, { name, content });
        saveState();
        // Langsung tawarkan pemilihan project (skill bisa dipilih mau ke mana).
        return offerAttach(
          ctx,
          user,
          skill,
          `✅ Skill "${skill.name}" ${updated ? 'diperbarui' : 'diimpor'} dari ${from}.`
        );
      } catch (err) {
        return ctx.reply(`❌ ${err.message}`);
      }
    }

    // /skill attach <id> [owner/repo] -> pasang ke project pilihan
    if (sub === 'attach') {
      const id = rest[0];
      const targetRepo = rest.slice(1).join(' ').trim();
      if (!id) return ctx.reply('Pakai: /skill attach <id> [owner/repo] (lihat daftar: /skills)');
      const skill = findSkill(user, id);
      if (!skill) return ctx.reply(`❌ Skill "${id}" tidak ditemukan. Daftar: /skills`);

      // Kalau project disebut eksplisit, pasang langsung ke situ.
      if (targetRepo) {
        const r = attachSkill(user, skill.id, targetRepo);
        saveState();
        if (!r.ok) return ctx.reply(`❌ ${r.reason}`);
        return ctx.reply(
          r.already
            ? `ℹ️ "${skill.name}" sudah terpasang di ${r.project}.`
            : `✅ "${skill.name}" dipasang ke ${r.project}.`
        );
      }

      // Tanpa project -> tampilkan tombol pilih project.
      return offerAttach(ctx, user, skill);
    }

    // /skill detach <id> -> lepas dari project aktif (atau semua kalau tidak ada)
    if (sub === 'detach') {
      const id = rest[0];
      if (!id) return ctx.reply('Pakai: /skill detach <id>');
      const skill = findSkill(user, id);
      if (!skill) return ctx.reply(`❌ Skill "${id}" tidak ditemukan.`);
      const r = detachSkill(user, skill.id, user.selectedRepo || '');
      saveState();
      if (!r.ok) return ctx.reply(`❌ ${r.reason}`);
      return ctx.reply(
        `✅ "${skill.name}" dilepas${r.project ? ` dari ${r.project}` : ' dari semua project'}.`
      );
    }

    // /skill del <id> -> hapus skill
    if (sub === 'del' || sub === 'delete' || sub === 'hapus') {
      const id = rest[0];
      if (!id) return ctx.reply('Pakai: /skill del <id>');
      const skill = findSkill(user, id);
      if (!skill) return ctx.reply(`❌ Skill "${id}" tidak ditemukan.`);
      deleteSkill(user, skill.id);
      saveState();
      return ctx.reply(`🗑️ Skill "${skill.name}" dihapus.`);
    }

    return ctx.reply(
      [
        'Pakai:',
        '/skills — lihat daftar skill',
        '/skill add <nama> — tambah (kirim isinya setelahnya)',
        '/skill import <path> — impor dari file project aktif',
        '/skill attach <id> — pasang ke project aktif',
        '/skill detach <id> — lepas dari project aktif',
        '/skill del <id> — hapus skill'
      ].join('\n')
    );
  });
}
