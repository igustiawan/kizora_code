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
    autoRestart: true,

    // Riwayat percakapan (hanya role user/assistant, teks saja)
    history: [],

    // State wizard setting: 'base' | 'token' | 'model'
    pendingInput: null,

    // Wizard skill: { step: 'name'|'content', name?: string }
    pendingSkill: null,

    // Skills: array of { id, name, content, description?, projects: string[], createdAt }
    skills: [],

    // Known projects (list of owner/repo) untuk attach tanpa perlu listRepos
    knownProjects: [],

    // Status runtime (tidak dipersistensi bermakna, aman kalau ke-reset)
    running: false,
    cancelRequested: false
  };
}

let state = { users: {} };

/**
 * Lengkapi user lama dengan field default yang belum ada.
 * state.json yang dibuat versi sebelumnya tidak punya `skills`, dsb — tanpa
 * merge ini, fitur baru akan crash karena `user.skills` undefined.
 */
export function normalizeUser(user) {
  const defaults = defaultUser();
  for (const [key, value] of Object.entries(defaults)) {
    if (user[key] === undefined || user[key] === null) {
      // history/pendingInput dkk boleh null -> ikut default
      user[key] = Array.isArray(value) ? [] : value;
    }
  }
  if (!user.llm || typeof user.llm !== 'object') user.llm = { ...defaults.llm };
  user.llm = { ...defaults.llm, ...user.llm };
  if (!user.github || typeof user.github !== 'object') user.github = { ...defaults.github };
  user.github = { ...defaults.github, ...user.github };
  if (!Array.isArray(user.history)) user.history = [];
  if (!Array.isArray(user.skills)) user.skills = [];
  if (!Array.isArray(user.knownProjects)) user.knownProjects = [];
  return user;
}

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
  } else {
    normalizeUser(state.users[key]);
  }
  return state.users[key];
}

export function isAllowed(userId) {
  if (CONFIG.allowedUsers.length === 0) return true;
  return CONFIG.allowedUsers.includes(String(userId));
}
