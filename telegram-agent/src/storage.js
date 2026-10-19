import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG } from './config.js';

const DATA_DIR = join(process.cwd(), 'data');
const STATE_FILE = join(DATA_DIR, 'state.json');

function defaultUser() {
  return {
    // Setting LLM (OpenAI-compatible)
    llm: { baseUrl: '', token: '', model: '' },

    // GitHub
    github: { token: '', username: '' },

    // Project aktif
    selectedRepo: null, // "owner/repo"
    workspace: null,    // path absolut hasil clone

    // Mode akses: 'ask' (konfirmasi tiap aksi) | 'full' (langsung jalan)
    mode: 'ask',

    // Auto commit+push setelah agent selesai
    autoPush: false,

    // Riwayat percakapan (hanya role user/assistant, teks saja)
    history: [],

    // State wizard setting: 'base' | 'token' | 'model'
    pendingInput: null,

    // Status runtime (tidak dipersistensi bermakna, aman kalau ke-reset)
    running: false,
    cancelRequested: false
  };
}

let state = { users: {} };

export function loadState() {
  if (existsSync(STATE_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.users) {
        state = parsed;
      }
    } catch {
      console.warn('state.json rusak, mulai dengan state kosong.');
      state = { users: {} };
    }
  }
}

export function saveState() {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function getUser(userId) {
  const key = String(userId);
  if (!state.users[key]) {
    state.users[key] = defaultUser();
    saveState();
  }
  return state.users[key];
}

export function isAllowed(userId) {
  if (CONFIG.allowedUsers.length === 0) return true;
  return CONFIG.allowedUsers.includes(String(userId));
}
