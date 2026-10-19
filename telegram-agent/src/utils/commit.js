/**
 * Penyusun pesan commit yang deskriptif.
 *
 * Auto-push sebelumnya memakai pesan generik
 * "chore: telegram-agent auto-commit <timestamp>" sehingga riwayat git tidak
 * informatif. Di sini judul diturunkan dari prompt user (apa yang diminta),
 * dengan prefix Conventional Commits, plus body berisi detail + file yang
 * berubah.
 */

/** Kata kunci -> tipe Conventional Commits. Urutan penting: yang lebih spesifik dulu. */
const TYPE_HINTS = [
  {
    type: 'fix',
    words: ['fix', 'perbaiki', 'perbaikan', 'benerin', 'bug', 'error', 'gagal', 'broken', 'repair']
  },
  {
    type: 'docs',
    words: ['docs', 'dokumentasi', 'readme', 'komentar', 'comment', 'panduan']
  },
  { type: 'test', words: ['test', 'testing', 'uji', 'unit test', 'spec'] },
  {
    type: 'refactor',
    words: ['refactor', 'rapikan', 'bersihkan', 'cleanup', 'rename', 'ganti nama', 'struktur ulang']
  },
  { type: 'style', words: ['style', 'format', 'prettier', 'lint', 'indentasi'] },
  { type: 'perf', words: ['perf', 'optimasi', 'optimize', 'percepat', 'lebih cepat', 'performance'] },
  {
    type: 'feat',
    words: [
      'tambah',
      'tambahkan',
      'menambah',
      'buat',
      'bikin',
      'fitur',
      'feature',
      'add',
      'implement',
      'implementasi',
      'create',
      'support',
      'dukung'
    ]
  }
];

export const COMMIT_TITLE_MAX = 72;

/** Prefix Conventional Commits yang dianggap valid. */
const CONVENTIONAL_RE = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([\w./-]+\))?!?:\s+\S/;

/** Tebak tipe commit dari teks prompt. Default: chore. */
export function detectCommitType(prompt = '') {
  const text = String(prompt).toLowerCase();
  for (const { type, words } of TYPE_HINTS) {
    if (words.some((word) => text.includes(word))) return type;
  }
  return 'chore';
}

/** Ringkas prompt jadi satu baris pendek untuk judul commit. */
export function summarizePrompt(prompt, maxLength = 60) {
  const clean = String(prompt ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  if (!clean) return 'perubahan tanpa deskripsi';

  const trimmed = clean.replace(/[.;,]+$/, '');
  if (trimmed.length <= maxLength) return trimmed;

  const cut = trimmed.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  const base = (lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
  return `${base}…`;
}

/**
 * Bangun pesan commit lengkap (judul + body).
 *
 * @param {object} opts
 * @param {string} opts.prompt  Prompt user yang memicu perubahan.
 * @param {string[]} opts.files Daftar file yang berubah (relatif repo).
 * @param {Date} opts.date      Waktu commit (untuk body).
 * @returns {{ title: string, body: string, message: string, type: string }}
 */
export function buildCommitMessage({ prompt = '', files = [], date = new Date() } = {}) {
  const type = detectCommitType(prompt);
  const summary = summarizePrompt(prompt, 60);

  // Judul: "tipe: ringkasan", dipotong rapi biar tidak kepanjangan.
  // Kalau prompt sudah pakai prefix Conventional Commits, jangan dobel.
  let title = CONVENTIONAL_RE.test(summary) ? summary : `${type}: ${summary}`;
  if (title.length > COMMIT_TITLE_MAX) {
    title = `${title.slice(0, COMMIT_TITLE_MAX - 1).trimEnd()}…`;
  }

  const fileList = Array.isArray(files) ? files.filter(Boolean) : [];
  const shownFiles = fileList.slice(0, 15);
  const bodyLines = [
    String(prompt ?? '').replace(/\s+/g, ' ').trim() || '(tanpa deskripsi prompt)'
  ];
  if (shownFiles.length) {
    const extra = fileList.length - shownFiles.length;
    bodyLines.push('', `File: ${shownFiles.join(', ')}${extra > 0 ? ` (+${extra} lainnya)` : ''}`);
  }
  bodyLines.push('', `Auto-commit oleh telegram-agent pada ${date.toISOString()}`);

  const body = bodyLines.join('\n');
  return { type, title, body, message: `${title}\n\n${body}` };
}

/**
 * Pastikan pesan commit dari LLM punya judul yang jelas.
 * Kalau belum ada prefix Conventional Commits, tambahkan tipe hasil deteksi.
 * Judul yang terlalu panjang dipotong supaya rapi di `git log --oneline`.
 */
export function ensureCommitTitle(message, maxTitle = COMMIT_TITLE_MAX) {
  const raw = String(message ?? '').replace(/\r\n/g, '\n').trim();
  if (!raw) return `chore: perubahan tanpa deskripsi`;

  const [firstLine, ...rest] = raw.split('\n');
  const bodyText = rest.join('\n').trim();

  let title = firstLine.trim();
  if (!CONVENTIONAL_RE.test(title)) {
    title = `${detectCommitType(title)}: ${title}`;
  }
  if (title.length > maxTitle) {
    title = `${title.slice(0, maxTitle - 1).trimEnd()}…`;
  }
  return bodyText ? `${title}\n\n${bodyText}` : title;
}
