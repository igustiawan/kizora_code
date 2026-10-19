import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';

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

/** Stage semua, commit, lalu push. Push pakai -u supaya aman walau branch belum punya upstream. */
export async function commitAndPush(dir, message) {
  const git = simpleGit(dir);
  const status = await git.status();
  if (status.files.length === 0) {
    return { committed: false, pushed: false, reason: 'tidak ada perubahan' };
  }
  await git.add('.');
  const result = await git.commit(message);
  await git.push(['-u', 'origin', 'HEAD']);
  return { committed: true, pushed: true, hash: result.commit };
}
