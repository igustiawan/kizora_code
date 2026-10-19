import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { ensureCommitTitle } from '../utils/commit.js';

export const WORKSPACE_ROOT = join(process.cwd(), 'workspace');

/** "owner/repo" -> path workspace lokal yang aman untuk filesystem. */
export function workspacePathFor(fullName) {
  return join(WORKSPACE_ROOT, fullName.replace(/[^\w.-]+/g, '__'));
}

/**
 * Clone repo (atau git pull kalau sudah ada).
 * Token diselipkan di URL clone supaya jalan untuk repo private.
 */
export async function cloneOrPullRepo(fullName, token) {
  const dest = workspacePathFor(fullName);
  mkdirSync(WORKSPACE_ROOT, { recursive: true });

  const url = `https://x-access-token:${token}@github.com/${fullName}.git`;

  if (existsSync(join(dest, '.git'))) {
    const git = simpleGit(dest);
    await git.pull();
    return { path: dest, pulled: true };
  }

  const git = simpleGit();
  await git.clone(url, dest);
  return { path: dest, pulled: false };
}

export function gitClient(dir) {
  return simpleGit(dir);
}

/** True kalau ada file berubah (staged/unstaged/untracked). */
export async function hasChanges(dir) {
  const git = simpleGit(dir);
  const status = await git.status();
  return status.files.length > 0;
}

/** Daftar path file yang berubah (staged/unstaged/untracked). */
export async function listChangedFiles(dir) {
  const git = simpleGit(dir);
  const status = await git.status();
  return status.files.map((f) => f.path);
}

/**
 * Stage semua, commit, lalu push. Push pakai -u supaya aman walau branch belum punya upstream.
 * Pesan commit selalu dinormalkan (ensureCommitTitle) agar judulnya jelas.
 */
export async function commitAndPush(dir, message) {
  const git = simpleGit(dir);
  const status = await git.status();
  if (status.files.length === 0) {
    return { committed: false, pushed: false, reason: 'tidak ada perubahan' };
  }
  await git.add('.');
  const finalMessage = ensureCommitTitle(message);
  const result = await git.commit(finalMessage);
  await git.push(['-u', 'origin', 'HEAD']);
  return {
    committed: true,
    pushed: true,
    hash: result.commit,
    message: finalMessage,
    title: finalMessage.split('\n')[0]
  };
}
