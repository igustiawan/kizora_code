/** Utility teks untuk Telegram + deskripsi tool call. */

/** Potong teks jadi potongan <= size karakter (limit Telegram 4096). */
export function chunkText(text, size = 4000) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks.length ? chunks : [''];
}

/** Kirim teks panjang ke chat, dipecah kalau perlu. */
export async function sendChunked(ctx, text) {
  for (const chunk of chunkText(text)) {
    await ctx.reply(chunk);
  }
}

/** Ringkasan human-readable sebuah tool call (dipakai di konfirmasi mode ASK). */
export function describeToolCall(name, args) {
  switch (name) {
    case 'list_files':
      return `📂 List isi folder: ${args.path || '(root project)'}`;
    case 'read_file':
      return `📖 Baca file: ${args.path}`;
    case 'write_file':
      return (
        `📝 Tulis file: ${args.path} (${String(args.content ?? '').length} karakter)\n` +
        `--- preview 600 char ---\n${String(args.content ?? '').slice(0, 600)}`
      );
    case 'edit_file':
      return (
        `✏️ Edit file: ${args.path}\n` +
        `--- cari ---\n${String(args.old_string ?? '').slice(0, 300)}\n` +
        `--- ganti jadi ---\n${String(args.new_string ?? '').slice(0, 300)}`
      );
    case 'run_command':
      return `💻 Jalankan command di workspace:\n${args.command}`;
    case 'git_status':
      return '📊 Cek git status';
    case 'git_commit':
      return `📦 Commit semua perubahan: "${args.message}"`;
    case 'git_push':
      return '🚀 Push commit ke remote GitHub';
    default:
      return `${name} ${JSON.stringify(args).slice(0, 300)}`;
  }
}

/** Inline keyboard konfirmasi aksi (mode ASK). */
export function approvalKeyboard(nonce) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Jalankan', callback_data: `approve:${nonce}` },
        { text: '❌ Tolak', callback_data: `reject:${nonce}` }
      ]
    ]
  };
}

/** Sensor token untuk tampilan (sisakan 4 char terakhir). */
export function maskToken(token) {
  if (!token) return '(belum diset)';
  if (token.length <= 4) return '****';
  return `${'*'.repeat(Math.min(12, token.length - 4))}${token.slice(-4)}`;
}
