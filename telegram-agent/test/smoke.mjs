/**
 * Smoke test: jalankan tool executor + git service di workspace sementara.
 * Tidak butuh token Telegram/LLM/GitHub.
 * Jalankan: npm run smoke
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec } from 'node:child_process';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { simpleGit } from 'simple-git';
import { executeTool } from '../src/tools/executor.js';
import { hasChanges, commitAndPush } from '../src/services/git.js';
import { chunkText, describeToolCall, maskToken } from '../src/utils/text.js';
import { registerBotMenu, registerBotMenuDetailed, validateCommands, BOT_COMMANDS } from '../src/services/menu.js';
import {
  HELP_TEXT_FOR_TEST as HELP_TEXT,
  mainMenuKeyboard,
  replyMenuKeyboard,
  ensureMenuKeyboardMiddleware,
  offerAttach,
  CLOSE_MENU_TEXT
} from '../src/handlers/commands.js';

let passed = 0;
let failed = 0;

const execAsync = promisify(exec);

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
// git_commit harus menormalkan judul ke Conventional Commits (bukan "init smoke" mentah)
check(
  'git_commit menormalkan judul commit',
  committed.includes('Judul: chore: init smoke')
);

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

// --- git_pull: kerja dari banyak mesin ---
console.log('git_pull:');
check('command /pull terdaftar di menu', BOT_COMMANDS.some((c) => c.command === 'pull'));
check('/pull disebut di HELP_TEXT', HELP_TEXT.includes('/pull '));
check(
  'command /pull terdaftar di bot',
  readFileSync(new URL('../src/handlers/commands.js', import.meta.url), 'utf8').includes("bot.command('pull'")
);

// simulasi mesin kedua: clone bare repo, ubah file, push
const ws2 = mkdtempSync(join(tmpdir(), 'kizora-smoke2-'));
const git2 = simpleGit(ws2);
await git2.clone(bare, ws2);
await git2.addConfig('user.email', 'smoke2@test.local');
await git2.addConfig('user.name', 'Smoke Test 2');
writeFileSync(join(ws2, 'hello.txt'), 'hello dari mesin 2');
writeFileSync(join(ws2, 'mesin2.txt'), 'file baru dari mesin 2');
await git2.add('.');
await git2.commit('feat: perubahan dari mesin kedua');
await git2.push(); // kirim ke bare repo supaya mesin 1 bisa menariknya

// mesin 1 belum lihat perubahan
check(
  'mesin 1 belum punya file mesin2',
  !existsSync(join(ws, 'mesin2.txt'))
);

const pullResult = await executeTool('git_pull', {}, ws);
check('git_pull melaporkan file berubah', pullResult.includes('file berubah'));
check('git_pull menyebut mesin2.txt', pullResult.includes('mesin2.txt'));
check(
  'isi hello.txt ter-update dari remote',
  readFileSync(join(ws, 'hello.txt'), 'utf8') === 'hello dari mesin 2'
);
check('file baru dari mesin 2 muncul', existsSync(join(ws, 'mesin2.txt')));

const pullAgain = await executeTool('git_pull', {}, ws);
check('git_pull kedua -> already up to date', pullAgain.includes('Already up to date'));

// --- utils ---
console.log('utils:');
const chunks = chunkText('x'.repeat(9500), 4000);
check('chunkText memecah 9500 char jadi 3 potongan', chunks.length === 3);
check('describeToolCall ada preview', describeToolCall('write_file', { path: 'a.txt', content: 'isi' }).includes('a.txt'));
check('maskToken menyensor', maskToken('sk-1234567890abcd').endsWith('abcd') && maskToken('').includes('belum'));

// --- menu command (tanpa jaringan, pakai API palsu) ---
console.log('menu:');
check('daftar command valid', validateCommands().length === 0);
check('command tidak valid terdeteksi', validateCommands([{ command: 'Bad-Cmd', description: 'x' }]).length === 1);
check('deskripsi kosong terdeteksi', validateCommands([{ command: 'ok', description: '' }]).length === 1);
check('command duplikat terdeteksi', validateCommands([
  { command: 'a', description: 'x' },
  { command: 'a', description: 'y' }
]).length === 1);
check('semua command di HELP_TEXT terdaftar di menu', BOT_COMMANDS.every((c) => HELP_TEXT.includes(`/${c.command} `)));

const fakeApi = {
  calls: [],
  async setMyCommands(commands, opts) {
    this.calls.push(['setMyCommands', opts?.scope?.type || 'default', commands.length]);
  },
  async setChatMenuButton(payload) {
    this.calls.push(['setChatMenuButton', payload.menu_button.type]);
  }
};
const menuOk = await registerBotMenu(fakeApi);
check('registerBotMenu sukses', menuOk === true);
check('setMyCommands dipanggil 3 scope', fakeApi.calls.filter((c) => c[0] === 'setMyCommands').length === 3);
check('tombol menu diset ke type commands', fakeApi.calls.some((c) => c[0] === 'setChatMenuButton' && c[1] === 'commands'));

const brokenApi = {
  async setMyCommands() {
    throw new Error('network down');
  },
  async setChatMenuButton() {}
};
check(
  'registerBotMenu tidak melempar saat gagal',
  (await registerBotMenu(brokenApi, BOT_COMMANDS, { retries: 0 })) === false
);

// satu scope gagal tidak boleh membatalkan scope lain
const partialApi = {
  calls: [],
  async setMyCommands(commands, opts) {
    const type = opts?.scope?.type || 'default';
    this.calls.push(type);
    if (type === 'all_group_chats') throw new Error('scope grup ditolak');
  },
  async setChatMenuButton() {
    this.calls.push('button');
  }
};
const partial = await registerBotMenuDetailed(partialApi, BOT_COMMANDS, { retries: 0 });
check(
  'scope gagal dilaporkan di detail',
  partial.ok === false && partial.failed.length === 1 && partial.failed[0].scope === 'semua grup'
);
check(
  'scope lain + tombol menu tetap didaftarkan',
  partialApi.calls.includes('default') &&
    partialApi.calls.includes('all_chat_administrators') &&
    partialApi.calls.includes('button')
);

// menu fallback (tombol inline) harus punya handler callback-nya
const menuKb = JSON.stringify(mainMenuKeyboard());
check(
  'menu fallback berisi tombol settings & project',
  menuKb.includes('menu:settings') && menuKb.includes('menu:repos')
);

// --- tutup menu: reply keyboard harus bisa diclose ---
console.log('tutup menu:');
const replyKb = JSON.stringify(replyMenuKeyboard());
check('tombol Tutup Menu ada di reply keyboard', replyKb.includes(CLOSE_MENU_TEXT));
check('/tutup terdaftar di menu Telegram', BOT_COMMANDS.some((c) => c.command === 'tutup'));
check('/tutup disebut di HELP_TEXT', HELP_TEXT.includes('/tutup '));

const messagesSrc = readFileSync(new URL('../src/handlers/messages.js', import.meta.url), 'utf8');
check('message handler memakai remove_keyboard', messagesSrc.includes('remove_keyboard'));
check(
  'tombol Tutup Menu dicek sebelum wizard setting',
  messagesSrc.indexOf('CLOSE_MENU_TEXT') < messagesSrc.indexOf('pendingInput')
);

const commandsSrcFull = readFileSync(new URL('../src/handlers/commands.js', import.meta.url), 'utf8');
check('command /tutup terdaftar di bot', commandsSrcFull.includes("bot.command('tutup'"));

// --- middleware menu: command apa pun memunculkan tombol menu ---
console.log('middleware menu:');
check('ensureMenuKeyboardMiddleware diekspor', typeof ensureMenuKeyboardMiddleware === 'function');
check('offerAttach diekspor', typeof offerAttach === 'function');

// command tanpa reply_markup -> otomatis dapat reply keyboard
let mwCaptured = null;
const mwCtx = {
  message: { text: '/project' },
  reply: async (msg, extra) => {
    mwCaptured = { msg, extra };
  }
};
await ensureMenuKeyboardMiddleware()(mwCtx, async () => {
  await mwCtx.reply('info project');
});
check(
  'command tanpa markup otomatis dapat reply keyboard',
  Array.isArray(mwCaptured?.extra?.reply_markup?.keyboard) &&
    mwCaptured.extra.reply_markup.keyboard.length > 0
);

// inline keyboard yang sudah ada tidak boleh ditimpa
let inlineCaptured = null;
const inlineCtx = {
  message: { text: '/settings' },
  reply: async (msg, extra) => {
    inlineCaptured = extra;
  }
};
await ensureMenuKeyboardMiddleware()(inlineCtx, async () => {
  await inlineCtx.reply('settings', { reply_markup: { inline_keyboard: [] } });
});
check(
  'inline keyboard tidak ditimpa middleware',
  JSON.stringify(inlineCaptured?.reply_markup || {}).includes('inline_keyboard')
);

// /tutup (remove_keyboard) juga tidak boleh ditimpa
let closeCaptured = null;
const closeCtx = {
  message: { text: '/tutup' },
  reply: async (msg, extra) => {
    closeCaptured = extra;
  }
};
await ensureMenuKeyboardMiddleware()(closeCtx, async () => {
  await closeCtx.reply('ditutup', { reply_markup: { remove_keyboard: true } });
});
check(
  'remove_keyboard (/tutup) tidak ditimpa middleware',
  closeCaptured?.reply_markup?.remove_keyboard === true
);

// pesan biasa (bukan command) tidak boleh dipaksa munculkan menu
let plainTouched = false;
const plainCtx = {
  message: { text: 'tolong refactor file ini' },
  reply: async () => {
    plainTouched = true;
  }
};
await ensureMenuKeyboardMiddleware()(plainCtx, async () => {
  await plainCtx.reply('sedang kerja');
});
check('pesan biasa tidak dipaksa pakai menu keyboard', plainTouched === true);

// --- skill handlers (tombol 🧠 Skills di /settings harus punya handler) ---
console.log('skills:');
check('command /skills terdaftar di menu', BOT_COMMANDS.some((c) => c.command === 'skills'));
check('command /skill terdaftar di menu', BOT_COMMANDS.some((c) => c.command === 'skill'));
check('command /batal terdaftar di menu', BOT_COMMANDS.some((c) => c.command === 'batal'));
check('/skills disebut di HELP_TEXT', HELP_TEXT.includes('/skills '));
check('/skill disebut di HELP_TEXT', HELP_TEXT.includes('/skill '));
check('/batal disebut di HELP_TEXT', HELP_TEXT.includes('/batal '));
check('command /skills terdaftar di bot', commandsSrcFull.includes("bot.command('skills'"));
check('command /skill terdaftar di bot', commandsSrcFull.includes("bot.command('skill'"));
check('command /batal terdaftar di bot', commandsSrcFull.includes("bot.command('batal'"));

// wizard skill: pesan isi skill harus ditangani di message handler
check(
  'wizard skill content ditangani',
  messagesSrc.includes("pendingSkill") && messagesSrc.includes('createSkill')
);

// logika skill service (tanpa jaringan)
const { createSkill, attachSkill, detachSkill, findSkill, skillsForProject, buildSkillsPrompt } =
  await import('../src/services/skills.js');
const fakeUser = { skills: [], knownProjects: ['owner/repo-a', 'owner/repo-b'], selectedRepo: 'owner/repo-a' };
createSkill(fakeUser, { name: 'React conventions', content: 'Pakai functional component.' });
createSkill(fakeUser, { name: 'Commit style', content: 'Commit pakai conventional commits.' });
check('skill tersimpan', fakeUser.skills.length === 2);
check('nama sama -> update bukan duplikat', (() => {
  createSkill(fakeUser, { name: 'react conventions', content: 'Isi baru.' });
  return fakeUser.skills.length === 2 && fakeUser.skills[0].content === 'Isi baru.';
})());
check('attach ke project', attachSkill(fakeUser, 'react-conventions', 'owner/repo-a').ok === true);
check('skillsForProject filter benar', skillsForProject(fakeUser, 'owner/repo-a').length === 1);
check('skillsForProject project lain kosong', skillsForProject(fakeUser, 'owner/repo-b').length === 0);
check('buildSkillsPrompt berisi nama skill', buildSkillsPrompt(fakeUser, 'owner/repo-a').includes('React conventions'));
check('buildSkillsPrompt kosong tanpa skill', buildSkillsPrompt(fakeUser, 'owner/repo-b') === '');
check('detach bekerja', detachSkill(fakeUser, 'react-conventions', 'owner/repo-a').ok === true);
check('findSkill by id', findSkill(fakeUser, 'commit-style')?.name === 'Commit style');

const commandsSrc = readFileSync(new URL('../src/handlers/commands.js', import.meta.url), 'utf8');
const callbacksSrc = readFileSync(new URL('../src/handlers/callbacks.js', import.meta.url), 'utf8');
const callbackData = [...commandsSrc.matchAll(/callback_data: '([^']+)'/g)].map((m) => m[1]);
const orphanButtons = callbackData.filter(
  (d) => !callbacksSrc.includes(`'${d}'`) && !callbacksSrc.includes(`'${d.split(':')[0]}:'`)
);
check('semua tombol punya handler callback', orphanButtons.length === 0, orphanButtons.join(', '));

// --- restart: harus hidup kembali dengan maupun tanpa supervisor ---
console.log('restart:');
const { isUnderSupervisor, planRestart, restartBot, waitForPredecessor, RESTART_EXIT_CODE } =
  await import('../src/utils/restart.js');

check('tanpa supervisor terdeteksi false', isUnderSupervisor({}) === false);
check('PM2_HOME -> supervisor', isUnderSupervisor({ PM2_HOME: '/home/x/.pm2' }) === true);
check('pm_id -> supervisor', isUnderSupervisor({ pm_id: '0' }) === true);
check('INVOCATION_ID (systemd) -> supervisor', isUnderSupervisor({ INVOCATION_ID: 'abc' }) === true);
check('JOURNAL_STREAM (systemd) -> supervisor', isUnderSupervisor({ JOURNAL_STREAM: '8:1' }) === true);

// planRestart: pilih mode tanpa efek samping (tidak spawn/mati).
// Env di-inject sebagai parameter — JANGAN mutasi process.env, karena
// process.env.X = ... menulis ke OS env asli dan spawn tanpa opsi env
// mewariskan OS env itu (bocor ke proses anak tes).
const planNoSup = planRestart({});
check(
  'tanpa supervisor -> rencana respawn',
  planNoSup.mode === 'respawn' && planNoSup.entry === process.argv[1]
);
check('dengan PM2 -> rencana supervisor', planRestart({ PM2_HOME: '/tmp/fake-pm2' }).mode === 'supervisor');

// restartBot mode supervisor: keluar dengan kode 75 (di-stub supaya tes tidak mati)
const realExit = process.exit;
const exitCodes = [];
process.exit = (code) => {
  exitCodes.push(code);
};
const r = restartBot({ delayMs: 30, env: { PM2_HOME: '/tmp/fake-pm2' } });
await new Promise((resolve) => setTimeout(resolve, 200));
process.exit = realExit;
check('restartBot mode supervisor', r.mode === 'supervisor');
check('keluar dengan kode 75 (supervisor restart)', exitCodes.length === 1 && exitCodes[0] === RESTART_EXIT_CODE && RESTART_EXIT_CODE === 75);

// waitForPredecessor: env tidak diset -> langsung jalan (0 ms)
const waited = await waitForPredecessor(() => {});
check('waitForPredecessor 0 tanpa env respawn', waited === 0);

// handler /restart & index.js memakai utility baru (bukan process.exit langsung)
check('/restart pakai restartBot', commandsSrc.includes('restartBot()'));
check('index.js tunggu proses lama mati', readFileSync(new URL('../src/index.js', import.meta.url), 'utf8').includes('waitForPredecessor'));
check('sync.js pakai restartBot', readFileSync(new URL('../src/services/sync.js', import.meta.url), 'utf8').includes('restartBot()'));

// respawn nyata (tanpa supervisor): proses pengganti HARUS hidup setelah
// proses lama mati — inilah yang bikin /restart tidak lagi mematikan bot
// kalau dijalankan tanpa PM2/systemd.
const respawnScript = join(tmpdir(), 'kizora-respawn-check.mjs');
const respawnLog = join(tmpdir(), 'kizora-respawn-check.log');
const restartModuleUrl = new URL('../src/utils/restart.js', import.meta.url).href;
rmSync(respawnLog, { force: true });
writeFileSync(
  respawnScript,
  [
    `import { appendFileSync } from 'node:fs';`,
    `const log = ${JSON.stringify(respawnLog)};`,
    `try {`,
    `  appendFileSync(log, 'parent pid=' + process.pid + ' pm2=' + (process.env.PM2_HOME||'-') + '\\n');`,
    `  if (process.env.KIZORA_RESPAWN_DELAY_MS) {`,
    `    await new Promise((r) => setTimeout(r, Number(process.env.KIZORA_RESPAWN_DELAY_MS)));`,
    `    appendFileSync(log, 'child-alive pid=' + process.pid + '\\n');`,
    `  } else {`,
    `    const { restartBot } = await import(${JSON.stringify(restartModuleUrl)});`,
    `    const r = restartBot({ delayMs: 200 });`,
    `    appendFileSync(log, 'restart mode=' + r.mode + '\\n');`,
    `  }`,
    `} catch (e) {`,
    `  appendFileSync(log, 'ERROR ' + (e && e.stack ? e.stack : e) + '\\n');`,
    `}`
  ].join('\n'),
  'utf8'
);
// Env eksplisit tanpa var supervisor, supaya tes tidak bergantung pada
// environment mesin yang menjalankan tes.
const respawnEnv = { ...process.env };
delete respawnEnv.PM2_HOME;
delete respawnEnv.pm_id;
delete respawnEnv.INVOCATION_ID;
delete respawnEnv.JOURNAL_STREAM;
// Jangan di-await: proses ini men-spawn proses lagi (stdio inherit), dan
// pipe-nya dipegang proses cucu — polling log jauh lebih andal.
const respawnProc = spawn(process.execPath, [respawnScript], {
  cwd: tmpdir(),
  stdio: 'ignore',
  detached: true,
  env: respawnEnv
});
respawnProc.unref();
let respawnOut = '';
for (let i = 0; i < 60; i++) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (existsSync(respawnLog)) {
    respawnOut = readFileSync(respawnLog, 'utf8');
    if (respawnOut.includes('child-alive')) break;
  }
}
const parentPid = respawnOut.match(/parent pid=(\d+)/)?.[1];
const childPid = respawnOut.match(/child-alive pid=(\d+)/)?.[1];
check('proses pengganti hidup setelah restart tanpa supervisor', Boolean(childPid), respawnOut);
check(
  'proses pengganti PID berbeda dari proses lama',
  Boolean(parentPid && childPid && parentPid !== childPid),
  `parent=${parentPid} child=${childPid}`
);
rmSync(respawnScript, { force: true });
rmSync(respawnLog, { force: true });

console.log(`\n${passed} lulus, ${failed} gagal.`);
if (failed > 0) process.exit(1);
console.log('SMOKE TEST PASSED');
