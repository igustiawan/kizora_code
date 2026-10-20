import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { simpleGit } from 'simple-git';
import { ensureCommitTitle } from '../utils/commit.js';

const execAsync = promisify(exec);

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out',
  '__pycache__', '.venv', 'venv', 'coverage', '.cache', 'target'
]);

const MAX_FILE_BYTES = 200 * 1024; // baca file maks 200KB
const MAX_CMD_OUTPUT = 6000;       // output command dipotong
const MAX_WALK_DEPTH = 3;

/** Semua path tool dikunci di dalam workspace (cegah path traversal). */
function safePath(workspace, p) {
  const base = resolve(workspace);
  const full = resolve(base, p || '.');
  const rel = relative(base, full);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path ditolak (di luar workspace): ${p}`);
  }
  return full;
}

function walk(dir, base, depth, out) {
  if (depth > MAX_WALK_DEPTH) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = entry.name;
    // skip hidden, kecuali .github/.vscode yang sering relevan
    if (name.startsWith('.') && !['.github', '.vscode'].includes(name)) continue;
    const full = join(dir, name);
    const rel = relative(base, full).split('\\').join('/');
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(name)) continue;
      out.dirs.push(rel);
      walk(full, base, depth + 1, out);
    } else {
      out.files.push(rel);
    }
  }
}

/**
 * Eksekusi satu tool call.
 * @returns {Promise<string>} hasil (selalu string, siap dikirim balik ke LLM)
 */
export async function executeTool(name, args, workspace) {
  switch (name) {
    case 'list_files': {
      const target = safePath(workspace, args.path || '.');
      if (!existsSync(target)) return `Error: folder tidak ditemukan: ${args.path}`;
      const out = { dirs: [], files: [] };
      walk(target, target, 0, out);
      const lines = [
        ...out.dirs.map((d) => `[dir]  ${d}/`),
        ...out.files.map((f) => `[file] ${f}`)
      ];
      return lines.length ? lines.join('\n') : '(folder kosong)';
    }

    case 'read_file': {
      const full = safePath(workspace, args.path);
      if (!existsSync(full)) return `Error: file tidak ditemukan: ${args.path}`;
      const size = statSync(full).size;
      if (size > MAX_FILE_BYTES) {
        return `Error: file terlalu besar (${size} bytes, maks ${MAX_FILE_BYTES})`;
      }
      return readFileSync(full, 'utf8');
    }

    case 'write_file': {
      const full = safePath(workspace, args.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, args.content ?? '', 'utf8');
      return `OK: ${args.path} ditulis (${String(args.content ?? '').length} karakter)`;
    }

    case 'edit_file': {
      const full = safePath(workspace, args.path);
      if (!existsSync(full)) return `Error: file tidak ditemukan: ${args.path}`;
      const content = readFileSync(full, 'utf8');
      const occurrences = content.split(args.old_string).length - 1;
      if (occurrences === 0) {
        return 'Error: old_string tidak ditemukan di file. Baca dulu isi file yang tepat.';
      }
      if (occurrences > 1) {
        return `Error: old_string muncul ${occurrences}x di file. Harus unik — sertakan lebih banyak konteks.`;
      }
      writeFileSync(full, content.replace(args.old_string, args.new_string), 'utf8');
      return `OK: ${args.path} berhasil diedit.`;
    }

    case 'run_command': {
      try {
        const { stdout, stderr } = await execAsync(args.command, {
          cwd: workspace,
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true
        });
        const combined = `exit 0\nstdout:\n${stdout}\nstderr:\n${stderr}`.trim();
        return combined.slice(0, MAX_CMD_OUTPUT) || '(command selesai, tidak ada output)';
      } catch (err) {
        const out = [
          `exit ${err.code ?? '?'}`,
          `stdout:\n${err.stdout ?? ''}`,
          `stderr:\n${err.stderr ?? err.message}`
        ].join('\n');
        return `Command gagal.\n${out}`.slice(0, MAX_CMD_OUTPUT);
      }
    }

    case 'git_status': {
      const git = simpleGit(workspace);
      const status = await git.status();
      if (!status.files.length) return 'Working tree bersih.';
      return [
        `Branch: ${status.current}`,
        ...status.files.map((f) => `${f.index || ' '}${f.working_dir || ' '} ${f.path}`)
      ].join('\n');
    }

    case 'git_commit': {
      const git = simpleGit(workspace);
      await git.add('.');
      const status = await git.status();
      if (!status.files.length) return 'Tidak ada perubahan untuk di-commit.';
      // Selalu normalkan judul commit ke format Conventional Commits yang jelas,
      // sama seperti jalur auto-push. Tanpa ini judul seperti "update"/"fix bug"
      // akan lolos apa adanya dan riwayat git jadi tidak informatif.
      const message = ensureCommitTitle(args.message);
      const result = await git.commit(message);
      return `Commit dibuat: ${result.commit}\nJudul: ${message.split('\n')[0]}`;
    }

    case 'git_push': {
      const git = simpleGit(workspace);
      const result = await git.push(['-u', 'origin', 'HEAD']);
      return `Push selesai. ${JSON.stringify(result).slice(0, 300)}`;
    }

    default:
      return `Error: tool tidak dikenal: ${name}`;
  }
}
