/**
 * Skill library: potongan instruksi/pengetahuan yang bisa dipasang ke
 * project tertentu.
 *
 * Kenapa perlu: prompt sistem agent sama untuk semua project. Padahal tiap
 * project punya konvensi sendiri (cara commit, struktur folder, gaya kode,
 * perintah test). Dengan "skill", user bisa menyimpan aturan tersebut sekali
 * lalu memasangnya hanya ke project yang relevan.
 *
 * Bentuk data (disimpan di state.json per user):
 *   user.skills = [{
 *     id: 'skill-react-1',
 *     name: 'React conventions',
 *     content: '...instruksi...',
 *     description: 'ringkasan singkat',
 *     projects: ['owner/repo'],   // project tempat skill ini aktif
 *     createdAt: '2026-...'
 *   }]
 *
 * Tidak ada dependency jaringan di sini supaya mudah dites.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';

export const MAX_SKILL_NAME = 60;
export const MAX_SKILL_CONTENT = 20_000;
/** Batas total karakter skill yang disuntik ke system prompt. */
export const MAX_PROMPT_SKILLS_CHARS = 12_000;
/** Batas callback_data Telegram. */
export const MAX_CALLBACK_DATA = 64;

/** ID pendek & aman untuk callback_data (<= 24 char). */
export function makeSkillId(name, existing = []) {
  const slug = String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 18) || 'skill';

  const taken = new Set(existing.map((s) => s.id));
  if (!taken.has(slug)) return slug;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${slug}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${slug}-${Date.now().toString(36)}`;
}

/** Cari skill berdasarkan id, lalu fallback ke nama (case-insensitive). */
export function findSkill(user, idOrName) {
  const key = String(idOrName ?? '').trim();
  if (!key) return null;
  const skills = Array.isArray(user?.skills) ? user.skills : [];
  return (
    skills.find((s) => s.id === key) ||
    skills.find((s) => s.name.toLowerCase() === key.toLowerCase()) ||
    null
  );
}

function normalizeProject(repo) {
  return String(repo ?? '').trim();
}

/** Tambah skill baru (belum dipasang ke project mana pun). */
export function createSkill(user, { name, content, description = '' }) {
  const cleanName = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!cleanName) throw new Error('Nama skill tidak boleh kosong.');
  if (cleanName.length > MAX_SKILL_NAME) {
    throw new Error(`Nama skill maksimal ${MAX_SKILL_NAME} karakter.`);
  }
  const cleanContent = String(content ?? '').trim();
  if (!cleanContent) throw new Error('Isi skill tidak boleh kosong.');
  if (cleanContent.length > MAX_SKILL_CONTENT) {
    throw new Error(`Isi skill terlalu panjang (maks ${MAX_SKILL_CONTENT} karakter).`);
  }

  if (!Array.isArray(user.skills)) user.skills = [];

  // Nama sama -> perbarui isinya, jangan bikin duplikat.
  const existing = user.skills.find((s) => s.name.toLowerCase() === cleanName.toLowerCase());
  if (existing) {
    existing.content = cleanContent;
    existing.description = description || existing.description || '';
    existing.updatedAt = new Date().toISOString();
    return { skill: existing, updated: true };
  }

  const skill = {
    id: makeSkillId(cleanName, user.skills),
    name: cleanName,
    description: String(description ?? '').trim(),
    content: cleanContent,
    projects: [],
    createdAt: new Date().toISOString()
  };
  user.skills.push(skill);
  return { skill, updated: false };
}

/** Hapus skill (otomatis lepas dari semua project). */
export function deleteSkill(user, idOrName) {
  const skill = findSkill(user, idOrName);
  if (!skill) return null;
  user.skills = (user.skills || []).filter((s) => s.id !== skill.id);
  return skill;
}

/** Pasang skill ke satu project. Return { ok, reason?, skill? }. */
export function attachSkill(user, idOrName, repo) {
  const skill = findSkill(user, idOrName);
  if (!skill) return { ok: false, reason: 'Skill tidak ditemukan.' };
  const project = normalizeProject(repo);
  if (!project) return { ok: false, reason: 'Project tidak boleh kosong.' };

  if (!Array.isArray(skill.projects)) skill.projects = [];
  if (skill.projects.includes(project)) {
    return { ok: true, already: true, skill, project };
  }
  skill.projects.push(project);
  return { ok: true, already: false, skill, project };
}

/** Lepas skill dari satu project (atau dari semua kalau repo kosong). */
export function detachSkill(user, idOrName, repo) {
  const skill = findSkill(user, idOrName);
  if (!skill) return { ok: false, reason: 'Skill tidak ditemukan.' };
  if (!Array.isArray(skill.projects)) skill.projects = [];

  if (!repo) {
    const count = skill.projects.length;
    skill.projects = [];
    return { ok: true, removed: count, skill, project: null };
  }

  const project = normalizeProject(repo);
  if (!skill.projects.includes(project)) {
    return { ok: false, reason: `Skill belum terpasang di ${project}.`, skill };
  }
  skill.projects = skill.projects.filter((p) => p !== project);
  return { ok: true, removed: 1, skill, project };
}

/** Semua skill yang aktif untuk project tertentu. */
export function skillsForProject(user, repo) {
  const project = normalizeProject(repo);
  if (!project) return [];
  return (user.skills || []).filter(
    (s) => Array.isArray(s.projects) && s.projects.includes(project)
  );
}

/**
 * Daftar project yang bisa dipilih saat memasang skill:
 * project aktif + project yang pernah dipakai, tanpa duplikat.
 */
export function projectChoices(user) {
  const list = [];
  if (user?.selectedRepo) list.push(user.selectedRepo);
  for (const repo of user?.knownProjects || []) {
    if (repo && !list.includes(repo)) list.push(repo);
  }
  return list;
}

/**
 * Blok teks skill untuk ditempel ke system prompt agent.
 * Kosong ("") kalau tidak ada skill aktif untuk project ini.
 */
export function buildSkillsPrompt(user, repo = user?.selectedRepo) {
  const active = skillsForProject(user, repo);
  if (!active.length) return '';

  const header = [
    '',
    '## Skill khusus project ini',
    'Instruksi berikut dipasang user khusus untuk project ini. Ikuti sebagai aturan',
    'tambahan selama tidak bertentangan dengan aturan kerja di atas:',
    ''
  ];

  let used = 0;
  const blocks = [];
  for (const skill of active) {
    const body = String(skill.content ?? '').trim();
    if (!body) continue;
    const remaining = MAX_PROMPT_SKILLS_CHARS - used;
    if (remaining <= 0) {
      blocks.push(`### ${skill.name}\n(dilewati: batas panjang skill tercapai)`);
      break;
    }
    const clipped = body.length > remaining ? `${body.slice(0, remaining)}\n…(dipotong)` : body;
    used += clipped.length;
    blocks.push(`### ${skill.name}\n${clipped}`);
  }

  if (!blocks.length) return '';
  return [...header, ...blocks].join('\n');
}

/** Ringkasan isi skill untuk ditampilkan di chat. */
export function previewSkillContent(content, maxLength = 700) {
  const text = String(content ?? '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}…`;
}

/**
 * Import skill dari file di dalam workspace project.
 * Path dikunci di dalam workspace (path traversal ditolak), ukuran dibatasi.
 *
 * @returns {{ name: string, content: string, path: string }}
 */
export function readSkillFromFile(workspace, relPath) {
  if (!workspace) throw new Error('Belum ada project aktif. Pilih project dengan /repos.');
  const raw = String(relPath ?? '').trim();
  if (!raw) throw new Error('Path file skill belum diisi.');

  const base = resolve(workspace);
  const full = resolve(base, raw);
  const rel = relative(base, full);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path ditolak (di luar workspace): ${raw}`);
  }
  if (!existsSync(full)) throw new Error(`File tidak ditemukan: ${raw}`);

  const size = statSync(full).size;
  if (size > MAX_SKILL_CONTENT) {
    throw new Error(
      `File terlalu besar (${size} bytes, maks ${MAX_SKILL_CONTENT}). Ringkas dulu isinya.`
    );
  }

  const content = readFileSync(full, 'utf8').trim();
  if (!content) throw new Error(`File kosong: ${raw}`);

  // Nama skill: heading pertama kalau ada, kalau tidak nama file tanpa ekstensi.
  const heading = content.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim();
  const fallback = basename(full).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
  const name = (heading || fallback).slice(0, MAX_SKILL_NAME);

  return { name, content: content.slice(0, MAX_SKILL_CONTENT), path: rel || raw };
}
