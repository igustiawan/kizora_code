/**
 * Smoke test: jalankan tool executor + git service di workspace sementara.
 * Tidak butuh token Telegram/LLM/GitHub.
 * Jalankan: npm run smoke
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { executeTool } from '../src/tools/executor.js';
import { hasChanges, commitAndPush } from '../src/services/git.js';
import { chunkText, describeToolCall, maskToken } from '../src/utils/text.js';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.error(`  ❌ ${label} ${detail}`);
  }
}

const ws = mkdtempSync(join(tmpdir(), 'kizora-smoke-'));
console.log(`Workspace uji: ${ws}\n`);

// --- setup file uji ---
writeFileSync(join(ws, 'hello.txt'), 'hello world');
mkdirSync(join(ws, 'src'), { recursive: true });
writeFileSync(join(ws, 'src', 'app.js'), 'console.log("v1");');

// --- list_files ---
console.log('list_files:');
const listed = await executeTool('list_files', {}, ws);
check('root listing memuat hello.txt', listed.includes('hello.txt'));
check('root listing memuat src/', listed.includes('src/'));
const listedSrc = await executeTool('list_files', { path: 'src' }, ws);
check('listing src memuat app.js', listedSrc.includes('app.js'));

// --- read_file ---
console.log('read_file:');
const read = await executeTool('read_file', { path: 'hello.txt' }, ws);
check('baca isi file', read === 'hello world');
const readMissing = await executeTool('read_file', { path: 'nope.txt' }, ws);
check('file hilang -> pesan error', readMissing.includes('tidak ditemukan'));

// --- write_file ---
console.log('write_file:');
const wrote = await executeTool('write_file', { path: 'deep/nested/file.txt', content: 'abc' }, ws);
check('tulis file + folder otomatis', existsSync(join(ws, 'deep/nested/file.txt')));
check('pesan sukses', wrote.startsWith('OK'));

// --- edit_file ---
console.log('edit_file:');
const edited = await executeTool(
  'edit_file',
  { path: 'hello.txt', old_string: 'world', new_string: 'kizora' },
  ws
);
check('edit berhasil', edited.startsWith('OK'));
check('isi berubah', readFileSync(join(ws, 'hello.txt'), 'utf8') === 'hello kizora');
const editMissing = await executeTool(
  'edit_file',
  { path: 'hello.txt', old_string: 'xyz', new_string: 'q' },
  ws
);
check('old_string hilang -> error', editMissing.includes('tidak ditemukan'));

// --- path traversal ditolak ---
console.log('path traversal:');
let blocked = false;
try {
  await executeTool('read_file', { path: '../secret.txt' }, ws);
} catch (err) {
  blocked = err.message.includes('ditolak');
}
check('path di luar workspace ditolak', blocked);

// --- run_command ---
console.log('run_command:');
const cmd = process.platform === 'win32' ? 'echo smoke-ok' : 'echo smoke-ok';
const cmdOut = await executeTool('run_command', { command: cmd }, ws);
check('command jalan', cmdOut.includes('smoke-ok'));
const cmdFail = await executeTool('run_command', { command: 'exit 3' }, ws);
check('command gagal -> exit code dilaporkan', cmdFail.includes('gagal'));

// --- git: init, commit, status, auto-push helper ---
console.log('git:');
const git = simpleGit(ws);
await git.init();
await git.addConfig('user.email', 'smoke@test.local');
await git.addConfig('user.name', 'Smoke Test');

const statusBefore = await executeTool('git_status', {}, ws);
check('git_status melihat file baru', statusBefore.includes('hello.txt'));

const committed = await executeTool('git_commit', { message: 'init smoke' }, ws);
check('commit dibuat', committed.includes('Commit dibuat'));

const statusAfter = await executeTool('git_status', {}, ws);
check('working tree bersih setelah commit', statusAfter.includes('bersih'));

writeFileSync(join(ws, 'hello.txt'), 'hello kizora v2');
check('hasChanges mendeteksi perubahan', (await hasChanges(ws)) === true);

// siapkan bare repo lokal sebagai "remote" supaya jalur push tervalidasi
const bare = mkdtempSync(join(tmpdir(), 'kizora-bare-'));
await simpleGit(bare).init(true);
await git.addRemote('origin', bare);

const pushResult = await commitAndPush(ws, 'chore: update');
check('commit perubahan kedua', pushResult.committed === true);
check('push ke remote sukses', pushResult.pushed === true);

const log = await git.log();
check('remote menerima commit', log.latest?.message === 'chore: update');

// --- utils ---
console.log('utils:');
const chunks = chunkText('x'.repeat(9500), 4000);
check('chunkText memecah 9500 char jadi 3 potongan', chunks.length === 3);
check('describeToolCall ada preview', describeToolCall('write_file', { path: 'a.txt', content: 'isi' }).includes('a.txt'));
check('maskToken menyensor', maskToken('sk-1234567890abcd').endsWith('abcd') && maskToken('').includes('belum'));

console.log(`\n${passed} lulus, ${failed} gagal.`);
if (failed > 0) process.exit(1);
console.log('SMOKE TEST PASSED');
