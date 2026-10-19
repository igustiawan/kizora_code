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

/**
 * Daftarkan menu ke Telegram.
 *
 * - scope default       : chat pribadi dengan bot
 * - all_group_chats     : grup (scope grup terpisah dari default)
 * - all_chat_administrators : admin grup, supaya tetap muncul saat bot dibatasi
 * - setChatMenuButton   : paksa tombol menu kiri bawah bertipe "commands"
 *
 * Tidak pernah melempar error: kalau gagal (mis. jaringan), bot tetap jalan
 * dan hanya mencatat peringatan.
 */
export async function registerBotMenu(api, commands = BOT_COMMANDS) {
  const errors = validateCommands(commands);
  if (errors.length) {
    console.warn(`[menu] daftar command dilewati: ${errors.join('; ')}`);
    return false;
  }

  try {
    await api.setMyCommands(commands);
    await api.setMyCommands(commands, { scope: { type: 'all_group_chats' } });
    await api.setMyCommands(commands, { scope: { type: 'all_chat_administrators' } });
    await api.setChatMenuButton({ menu_button: { type: 'commands' } });
    return true;
  } catch (err) {
    console.warn(`[menu] gagal mendaftarkan menu: ${err.message}`);
    return false;
  }
}
