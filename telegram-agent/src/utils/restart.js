/**
 * Restart proses bot yang bekerja dalam dua situasi:
 *
 * 1. Ada supervisor (PM2 / systemd) — keluar dengan kode 75 dan biarkan
 *    supervisor yang menyalakan ulang. Ini jalur normal di VPS.
 * 2. TIDAK ada supervisor (npm start biasa, nohup, double-click) — kalau
 *    proses cuma exit, bot MATI PERMANEN. Jadi proses ini menyalankan
 *    proses pengganti (detached) lebih dulu, menunggu proses lama berhenti
 *    polling, lalu yang baru mulai — hindari Telegram 409 Conflict.
 *
 * Kenapa proses baru harus menunggu: grammY melempar error saat getUpdates
 * kena 409 (dua proses polling bersamaan), dan bot baru akan mati kalau
 * proses lama masih memegang lock polling Telegram.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Kode keluar "coba lagi nanti" — dipakai supervisor untuk me-restart. */
export const RESTART_EXIT_CODE = 75;

/** Env var yang memberi tahu proses baru: tunggu proses lama mati dulu. */
export const RESPAWN_DELAY_ENV = 'KIZORA_RESPAWN_DELAY_MS';

/**
 * Deteksi apakah proses ini dikelola supervisor yang bisa menyalakan ulang
 * kita saat keluar dengan kode 75.
 *
 * - PM2 menyuntikkan PM2_HOME / pm_id ke env proses anak.
 * - systemd menyuntikkan INVOCATION_ID (dan JOURNAL_STREAM) ke unit service.
 */
export function isUnderSupervisor(env = process.env) {
  return Boolean(
    env.PM2_HOME ||
      env.pm_id !== undefined ||
      env.INVOCATION_ID ||
      env.JOURNAL_STREAM
  );
}

/**
 * Rencana restart: mode apa yang akan dipakai, tanpa efek samping.
 * Dipisahkan dari restartBot supaya bisa dites tanpa memicu proses nyata.
 *
 * @param {NodeJS.ProcessEnv} [env] default process.env (bisa di-inject untuk tes)
 * @returns {{mode: 'supervisor'|'respawn'|'exit-only', entry?: string, args?: string[]}}
 */
export function planRestart(env = process.env) {
  if (isUnderSupervisor(env)) return { mode: 'supervisor' };
  const entry = process.argv[1];
  if (!entry || !existsSync(entry)) return { mode: 'exit-only' };
  return { mode: 'respawn', entry, args: process.argv.slice(2) };
}

/**
 * Restart proses bot.
 *
 * @param {object} [opts]
 * @param {number} [opts.delayMs] jeda sebelum proses lama keluar (default 600).
 *   Memberi waktu balasan Telegram terkirim + proses lama melepas lock polling.
 * @param {NodeJS.ProcessEnv} [opts.env] env untuk deteksi supervisor + proses
 *   pengganti (default process.env). Bisa di-inject untuk tes.
 * @returns {{mode: 'supervisor'|'respawn'|'exit-only', pid?: number}}
 */
export function restartBot({ delayMs = 600, env = process.env } = {}) {
  const delay = Math.max(0, Number(delayMs) || 0);
  const plan = planRestart(env);

  if (plan.mode === 'supervisor') {
    setTimeout(() => process.exit(RESTART_EXIT_CODE), delay);
    return { mode: 'supervisor' };
  }

  if (plan.mode === 'exit-only') {
    // Entry tidak diketahui — jatuh kembali ke jalur exit code.
    setTimeout(() => process.exit(RESTART_EXIT_CODE), delay);
    return { mode: 'exit-only' };
  }

  const child = spawn(process.execPath, [plan.entry, ...plan.args], {
    cwd: process.cwd(),
    stdio: 'inherit', // log proses baru tetap kelihatan di terminal yang sama
    env: {
      ...env,
      // Proses baru menunggu sampai proses ini benar-benar mati, supaya
      // tidak ada dua proses polling Telegram bersamaan (409 Conflict).
      [RESPAWN_DELAY_ENV]: String(delay + 500)
    },
    detached: true, // proses baru tetap hidup setelah proses ini keluar
    windowsHide: false
  });
  child.unref();

  setTimeout(() => process.exit(0), delay);
  return { mode: 'respawn', pid: child.pid };
}

/**
 * Kalau proses ini adalah hasil respawn (lihat restartBot), tunggu sampai
 * proses lama selesai mati sebelum mulai polling Telegram.
 * Dipanggil sekali di index.js sebelum bot.start().
 */
export async function waitForPredecessor(log = console.log) {
  const ms = Number(process.env[RESPAWN_DELAY_ENV] || 0);
  if (!ms || ms <= 0) return 0;
  log(`[restart] menunggu ${ms}ms sampai proses lama berhenti...`);
  await new Promise((resolve) => setTimeout(resolve, ms));
  return ms;
}
