import { config as loadDotenv } from 'dotenv';

loadDotenv();

export const CONFIG = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',

  // Batas iterasi agentic loop per prompt (cegah loop tak henti-hentinya)
  maxIterations: Number(process.env.AGENT_MAX_ITERATIONS || 25),

  // Timeout approval aksi di mode ASK (ms)
  approvalTimeoutMs: Number(process.env.APPROVAL_TIMEOUT_MS || 15 * 60 * 1000),

  // Whitelist Telegram user id (csv). Kosong = semua user boleh.
  allowedUsers: (process.env.ALLOWED_TELEGRAM_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
};
