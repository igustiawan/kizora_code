/**
 * Sinkronisasi kode bot dari workspace repo ke direktori bot yang aktif,
 * lalu restart proses bot supaya perubahan langsung kepakai.
 *
 * Kenapa perlu: bot berjalan dari direktori project sendiri, sementara agent
 * mengedit file di workspace clone (workspace/<owner>__<repo>). Tanpa sinkron,
 * perubahan kode yang di-commit agent tidak pernah ter-load oleh bot aktif.
 *
 * Strategi aman:
 * 1. Deteksi file yang berbeda (rsync --dry-run / itemize).
 * 2. Kalau ada beda, backup direktori aktif ke backups/<timestamp>/.
 * 3. Sinkron src/ (dan file root yang relevan) dari workspace.
 * 4. Restart: kalau dijalankan di bawah PM2/systemd, proses di-restart oleh
 *    supervisor. Kalau tidak, proses ini sendiri keluar dengan kode 75
 *    (EX_TEMPFAIL) supaya wrapper npm/pm2 me-restart-nya.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, cpSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Direktori bot yang sedang berjalan (induk dari src/). */
export const BOT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Direktori induk workspace: <BOT_ROOT>/workspace */
export const WORKSPACE_ROOT = join(BOT_ROOT, 'workspace');

/** Direktori backup sinkronisasi. */
export const BACKUP_ROOT = join(BOT_ROOT, 'backups');

/** Kode keluar "coba lagi nanti" — dipakai wrapper untuk me-restart. */
export const RESTART_EXIT_CODE = 75;

/** Folder/file yang tidak boleh disalin dari workspace (data runtime bot). */
const EXCLUDE_PATTERNS = [
  'node_modules',
  '.git',
  'workspace',
  'backups',
  'data',
  '.env',
  'logs',
  '*.log',
  '.DS_Store'
];

/**
 * Cari direktori telegram-agent di dalam workspace repo.
 * Workspace bisa berisi repo apa saja, jadi cari folder yang punya src/index.js.
 *
 * @param {string} workspaceRoot
 * @returns {string|null} path sumber yang valid, atau null
 */
export function findBotSource(workspaceRoot = WORKSPACE_ROOT) {
  if (!workspaceRoot || !existsSync(workspaceRoot)) return null;

  // Kasus 1: workspaceRoot sendiri adalah direktori bot
  if (existsSync(join(workspaceRoot, 'src', 'index.js'))) return workspaceRoot;

  // Kasus 2: cari satu level di bawah (workspace/<owner>__<repo>/telegram-agent)
  try {
    for (const entry of readdirSync(workspaceRoot)) {
      const repoDir = join(workspaceRoot, entry);
      if (!statSync(repoDir).isDirectory()) continue;

      const direct = join(repoDir, 'telegram-agent');
      if (existsSync(join(direct, 'src', 'index.js'))) return direct;

      // Kasus 3: cari dua level (workspace/<owner>__<repo>/<sub>/telegram-agent)
      for (const sub of readdirSync(repoDir)) {
        const subDir = join(repoDir, sub);
        if (!statSync(subDir).isDirectory()) continue;
        const nested = join(subDir, 'telegram-agent');
        if (existsSync(join(nested, 'src', 'index.js'))) return nested;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Daftar file (bukan direktori) yang berbeda antara sumber dan tujuan. */
async function listDifferentFiles(source, target) {
  const args = [
    '-rmn',
    '--itemize-changes',
    '--checksum', // bandingkan isi, bukan mtime (mtime beda bukan perubahan nyata)
    ...EXCLUDE_PATTERNS.flatMap((p) => ['--exclude', p]),
    `${source}/`,
    `${target}/`
  ];
  const { stdout } = await execFileAsync('rsync', args, { maxBuffer: 10 * 1024 * 1024 });
  return stdout
    .split('\n')
    .map((line) => {
      // Format itemize-changes: ">f.st...... path" — kode status lalu path.
      // Karakter kedua kode = tipe item: f=file, d=dir, L=symlink.
      // Hanya file yang dilaporkan (direktori tidak informatif untuk user).
      const m = line.match(/^[<>ch.*]f[^\s]*\s+(.+)$/);
      return m ? m[1].trim() : null;
    })
    .filter(Boolean);
}

/** Backup direktori bot aktif (src/ + package.json) ke backups/<timestamp>/. */
function backupCurrentBot() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = join(BACKUP_ROOT, stamp);
  mkdirSync(dest, { recursive: true });
  if (existsSync(join(BOT_ROOT, 'src'))) {
    cpSync(join(BOT_ROOT, 'src'), join(dest, 'src'), { recursive: true });
  }
  if (existsSync(join(BOT_ROOT, 'package.json'))) {
    cpSync(join(BOT_ROOT, 'package.json'), join(dest, 'package.json'));
  }
  return dest;
}

/** Sisakan hanya N backup terbaru supaya disk tidak penuh. */
function pruneBackups(keep = 5) {
  if (!existsSync(BACKUP_ROOT)) return;
  const dirs = readdirSync(BACKUP_ROOT)
    .map((name) => ({ name, path: join(BACKUP_ROOT, name), mtime: statSync(join(BACKUP_ROOT, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const old of dirs.slice(keep)) {
    rmSync(old.path, { recursive: true, force: true });
  }
}

/**
 * Sinkronkan kode bot dari workspace lalu restart.
 *
 * @param {object} [opts]
 * @param {string} [opts.workspaceRoot] default: <BOT_ROOT>/workspace
 * @param {boolean} [opts.restart] default true. false = sinkron saja (buat tes)
 * @returns {Promise<{synced: boolean, restarted: boolean, files: string[], backup: string|null, source: string|null, reason?: string}>}
 */
export async function syncAndRestart({ workspaceRoot = WORKSPACE_ROOT, restart = true } = {}) {
  const source = findBotSource(workspaceRoot);
  if (!source) {
    return {
      synced: false,
      restarted: false,
      files: [],
      backup: null,
      source: null,
      reason: 'Direktori bot tidak ditemukan di workspace.'
    };
  }

  const different = await listDifferentFiles(source, BOT_ROOT);
  if (different.length === 0) {
    return {
      synced: false,
      restarted: false,
      files: [],
      backup: null,
      source: relative(BOT_ROOT, source),
      reason: 'Kode sudah sinkron, tidak ada yang perlu di-copy.'
    };
  }

  // Ada perubahan: backup dulu baru copy
  const backup = backupCurrentBot();

  const args = [
    '-rm',
    '--itemize-changes',
    '--checksum',
    ...EXCLUDE_PATTERNS.flatMap((p) => ['--exclude', p]),
    `${source}/`,
    `${BOT_ROOT}/`
  ];
  await execFileAsync('rsync', args, { maxBuffer: 10 * 1024 * 1024 });
  pruneBackups();

  if (!restart) {
    return {
      synced: true,
      restarted: false,
      files: different,
      backup,
      source: relative(BOT_ROOT, source),
      reason: 'Sinkron selesai (restart dilewati).'
    };
  }

  // Restart. Kalau ada supervisor (PM2/systemd), dia yang menangani.
  // Kalau tidak, proses ini keluar dengan kode 75 supaya wrapper me-restart.
  console.log(`[sync] ${different.length} file berubah. Restart bot...`);
  setTimeout(() => process.exit(RESTART_EXIT_CODE), 500);
  return {
    synced: true,
    restarted: true,
    files: different,
    backup,
    source: relative(BOT_ROOT, source),
    reason: 'Sinkron selesai, proses akan restart.'
  };
}

/**
 * Cek apakah kode workspace berbeda dari bot aktif, tanpa mengubah apa pun.
 * Dipakai untuk laporan status ke user.
 */
export async function checkSyncStatus(workspaceRoot = WORKSPACE_ROOT) {
  const source = findBotSource(workspaceRoot);
  if (!source) return { ok: false, source: null, files: [], reason: 'Sumber tidak ditemukan.' };
  try {
    const files = await listDifferentFiles(source, BOT_ROOT);
    return { ok: true, source: relative(BOT_ROOT, source), files, reason: null };
  } catch (err) {
    return { ok: false, source: relative(BOT_ROOT, source), files: [], reason: err.message };
  }
}
