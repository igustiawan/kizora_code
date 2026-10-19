/**
 * Registrasi menu slash-command Telegram.
 *
 * Telegram hanya menampilkan daftar "/" kalau bot memanggil setMyCommands.
 * Tanpa ini, user harus hafal perintahnya — tidak ada menu di sisi klien.
 *
 * Daftar di bawah adalah satu-satunya sumber kebenaran: kalau menambah
 * bot.command(...) baru di handlers/commands.js, tambahkan juga di sini.
 */

export const BOT_COMMANDS = [
  { command: 'start', description: 'Mulai & panduan setup' },
  { command: 'help', description: 'Daftar semua perintah' },
  { command: 'settings', description: 'Lihat & ubah setting (tombol)' },
  { command: 'setbase', description: 'Set base URL LLM' },
  { command: 'settoken', description: 'Set token LLM' },
  { command: 'setmodel', description: 'Set nama model LLM' },
  { command: 'mode', description: 'Mode akses: full | ask' },
  { command: 'autopush', description: 'Auto commit+push: on | off' },
  { command: 'connect', description: 'Konek akun GitHub (token)' },
  { command: 'repos', description: 'Pilih project (auto clone/pull)' },
  { command: 'project', description: 'Info project aktif' },
  { command: 'cancel', description: 'Batalkan tugas yang berjalan' },
  { command: 'reset', description: 'Hapus riwayat percakapan' },
  { command: 'menu', description: 'Daftarkan ulang menu / (kalau tak muncul)' }
];

/**
 * Scope tempat menu didaftarkan. Scope "default" = chat pribadi.
 * Dipisah supaya satu scope gagal tidak membatalkan scope lain.
 */
export const MENU_SCOPES = [
  { key: 'private', label: 'chat pribadi', options: undefined },
  { key: 'groups', label: 'semua grup', options: { scope: { type: 'all_group_chats' } } },
  {
    key: 'admins',
    label: 'admin grup',
    options: { scope: { type: 'all_chat_administrators' } }
  }
];

/** Validasi ringan: Telegram menolak command >32 char atau karakter aneh. */
export function validateCommands(commands = BOT_COMMANDS) {
  const errors = [];
  const seen = new Set();
  for (const { command, description } of commands) {
    if (!/^[a-z0-9_]{1,32}$/.test(command || '')) {
      errors.push(`command tidak valid: "${command}"`);
    }
    if (seen.has(command)) errors.push(`command duplikat: "${command}"`);
    seen.add(command);
    if (!description || description.length > 256) {
      errors.push(`deskripsi tidak valid untuk "${command}"`);
    }
  }
  return errors;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Jalankan satu panggilan API dengan beberapa percobaan.
 * Tidak pernah melempar: hasilnya { ok, error }.
 */
async function callWithRetry(fn, { retries = 1, delayMs = 500 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await fn();
      return { ok: true };
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(delayMs * (attempt + 1));
    }
  }
  return { ok: false, error: lastError };
}

/**
 * Daftarkan menu dan kembalikan detail hasil per scope.
 *
 * Hasil: { ok, errors, failed: [{ scope, error }] }
 * - errors : masalah daftar command (validasi lokal, menu tidak dikirim)
 * - failed : panggilan API yang gagal setelah retry
 */
export async function registerBotMenuDetailed(
  api,
  commands = BOT_COMMANDS,
  options = { retries: 1, delayMs: 500 }
) {
  const errors = validateCommands(commands);
  if (errors.length) {
    console.warn(`[menu] daftar command dilewati: ${errors.join('; ')}`);
    return { ok: false, errors, failed: [] };
  }

  const failed = [];

  for (const scope of MENU_SCOPES) {
    const result = await callWithRetry(() => api.setMyCommands(commands, scope.options), options);
    if (!result.ok) {
      failed.push({ scope: scope.label, error: result.error?.message || String(result.error) });
    }
  }

  const button = await callWithRetry(
    () => api.setChatMenuButton({ menu_button: { type: 'commands' } }),
    options
  );
  if (!button.ok) {
    failed.push({
      scope: 'tombol menu',
      error: button.error?.message || String(button.error)
    });
  }

  if (failed.length) {
    console.warn(
      `[menu] gagal mendaftarkan menu: ${failed.map((f) => `${f.scope} → ${f.error}`).join('; ')}`
    );
  }

  return { ok: failed.length === 0, errors: [], failed };
}

/**
 * Versi ringkas: cukup true/false, tidak pernah melempar.
 * Kalau gagal, bot tetap jalan dan hanya mencatat peringatan.
 */
export async function registerBotMenu(api, commands = BOT_COMMANDS, options) {
  try {
    const detail = await registerBotMenuDetailed(api, commands, options);
    return detail.ok;
  } catch (err) {
    console.warn(`[menu] gagal mendaftarkan menu: ${err.message}`);
    return false;
  }
}
