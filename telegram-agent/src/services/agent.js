import { CONFIG } from '../config.js';
import { saveState } from '../storage.js';
import { chatCompletion } from './llm.js';
import { executeTool } from '../tools/executor.js';
import { READONLY_TOOLS, toolDefinitions } from '../tools/definitions.js';
import { hasChanges, commitAndPush, listChangedFiles } from './git.js';
import { buildCommitMessage } from '../utils/commit.js';
import { approvalKeyboard, describeToolCall, sendChunked } from '../utils/text.js';

/**
 * Approval yang sedang menunggu user (mode ASK).
 * key: `${userId}:${nonce}` -> { resolve(approved: boolean) }
 */
const pendingApprovals = new Map();

/** Buat promise yang resolve ketika user klik Approve/Reject (atau timeout). */
function requestApproval(userId, nonce) {
  return new Promise((resolvePromise) => {
    const key = `${userId}:${nonce}`;
    const timer = setTimeout(() => {
      pendingApprovals.delete(key);
      resolvePromise(false); // timeout dianggap tolak
    }, CONFIG.approvalTimeoutMs);
    pendingApprovals.set(key, {
      resolve: (approved) => {
        clearTimeout(timer);
        resolvePromise(approved);
      }
    });
  });
}

/** Resolve approval dari callback button. Return false kalau nonce tidak ada/kedaluwarsa. */
export function settleApproval(userId, nonce, approved) {
  const key = `${userId}:${nonce}`;
  const entry = pendingApprovals.get(key);
  if (!entry) return false;
  pendingApprovals.delete(key);
  entry.resolve(approved);
  return true;
}

/** Batalkan semua approval milik user (dipakai /cancel). */
export function cancelPendingApprovals(userId) {
  for (const [key, entry] of [...pendingApprovals]) {
    if (key.startsWith(`${userId}:`)) {
      pendingApprovals.delete(key);
      entry.resolve(false);
    }
  }
}

function buildSystemPrompt(user) {
  return [
    'Kamu adalah agen coding otonom yang bekerja di dalam sebuah project git.',
    `Project: ${user.selectedRepo}`,
    `Workspace: ${user.workspace}`,
    '',
    'Aturan kerja:',
    '- Gunakan tools untuk menjelajah project sebelum mengubah apa pun.',
    '- Jangan mengarang isi file yang belum kamu baca.',
    '- Kalau diminta memperbaiki bug, cari dulu file relevan, baca, baru edit.',
    '- Setelah selesai, jalankan test/build kalau project punya.',
    '- Kalau memanggil git_commit / membuat commit, tulis JUDUL yang jelas dan',
    '  spesifik dalam format Conventional Commits: "tipe: ringkasan singkat"',
    '  (tipe: feat, fix, docs, refactor, test, chore, perf, style).',
    '  Contoh: "fix: cegah crash saat token kosong", "feat: tambah tombol menu Telegram".',
    '  Jangan pakai judul generik seperti "update", "fix bug", atau "changes".',
    '- Jelaskan hasil kerja secara ringkas dalam bahasa Indonesia.',
    '- Jawab selalu dalam bahasa Indonesia kecuali user minta lain.'
  ].join('\n');
}

/**
 * Agentic loop utama: kirim prompt ke LLM, eksekusi tool calls,
 * ulangi sampai LLM memberi jawaban final (tanpa tool call).
 */
export async function runAgent(ctx, user, prompt) {
  // --- validasi prasyarat ---
  if (!user.llm.baseUrl || !user.llm.token || !user.llm.model) {
    await ctx.reply('⚠️ Setting LLM belum lengkap. Buka /settings dulu.');
    return;
  }
  if (!user.workspace || !user.selectedRepo) {
    await ctx.reply('⚠️ Belum ada project aktif. Pakai /connect lalu /repos untuk pilih project.');
    return;
  }
  if (user.running) {
    await ctx.reply('⏳ Masih ada tugas berjalan. Kirim /cancel kalau mau membatalkan.');
    return;
  }

  user.running = true;
  user.cancelRequested = false;
  saveState();

  const messages = [
    { role: 'system', content: buildSystemPrompt(user) },
    ...user.history.slice(-20), // konteks percakapan sebelumnya
    { role: 'user', content: prompt }
  ];

  let statusMsg = null;
  let finalText = '';

  try {
    statusMsg = await ctx.reply(`🤖 Agent mulai kerja di ${user.selectedRepo}...`);

    for (let iteration = 0; iteration < CONFIG.maxIterations; iteration++) {
      if (user.cancelRequested) {
        await ctx.reply('🛑 Tugas dibatalkan.');
        return;
      }

      const res = await chatCompletion({
        baseUrl: user.llm.baseUrl,
        token: user.llm.token,
        model: user.llm.model,
        messages,
        tools: toolDefinitions
      });

      const msg = res.choices?.[0]?.message;
      if (!msg) throw new Error('Response LLM tidak valid (tidak ada choices[0].message).');

      messages.push(msg);

      // Tidak ada tool call -> ini jawaban final
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        finalText = msg.content || '(agent tidak memberi jawaban teks)';
        break;
      }

      // Eksekusi semua tool call di iterasi ini
      for (const call of msg.tool_calls) {
        if (user.cancelRequested) {
          await ctx.reply('🛑 Tugas dibatalkan.');
          return;
        }

        const fnName = call.function?.name ?? '(unknown)';
        let fnArgs = {};
        try {
          fnArgs = JSON.parse(call.function?.arguments || '{}');
        } catch {
          // biarkan {} kalau JSON rusak; tool akan error dengan jelas
        }

        // Mode ASK: minta konfirmasi untuk aksi yang mengubah sesuatu
        let approved = true;
        if (user.mode === 'ask' && !READONLY_TOOLS.has(fnName)) {
          const nonce = Math.random().toString(36).slice(2, 10);
          await ctx.reply(describeToolCall(fnName, fnArgs), {
            reply_markup: approvalKeyboard(nonce)
          });
          approved = await requestApproval(ctx.from.id, nonce);
        }

        let result;
        if (!approved) {
          result =
            'DITOLAK oleh user. Jangan ulangi aksi ini. Jelaskan kenapa aksi dibutuhkan atau cari alternatif lain.';
        } else {
          try {
            result = await executeTool(fnName, fnArgs, user.workspace);
          } catch (err) {
            result = `Error menjalankan ${fnName}: ${err.message}`;
          }
          try {
            await ctx.api.editMessageText(
              ctx.chat.id,
              statusMsg.message_id,
              `⚙️ Iterasi ${iteration + 1}: ${fnName} selesai.`
            );
          } catch {
            // status message bisa gagal di-edit (mis. teks identik) — abaikan
          }
        }

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: String(result).slice(0, 8000)
        });
      }
    }

    // --- simpan history (teks saja, tool messages tidak dipersistensi) ---
    user.history.push({ role: 'user', content: prompt });
    if (finalText) user.history.push({ role: 'assistant', content: finalText });
    if (user.history.length > 40) user.history = user.history.slice(-40);
    saveState();

    if (finalText) {
      await sendChunked(ctx, finalText);
    } else {
      await ctx.reply(
        `⚠️ Agent berhenti tanpa jawaban final (mencapai batas ${CONFIG.maxIterations} iterasi).`
      );
    }

    // --- auto-push: commit + push sisa perubahan kalau setting ON ---
    if (user.autoPush) {
      try {
        if (await hasChanges(user.workspace)) {
          const files = await listChangedFiles(user.workspace);
          const commit = buildCommitMessage({ prompt, files });
          const r = await commitAndPush(user.workspace, commit.message);
          if (r.pushed) {
            await ctx.reply(
              [
                '🚀 Auto-push berhasil.',
                `📝 Commit: ${r.title || commit.title}`,
                `🔖 Hash: ${String(r.hash).slice(0, 7)}`
              ].join('\n')
            );
          }
        }
      } catch (err) {
        await ctx.reply(`⚠️ Auto-push gagal: ${err.message}`);
      }
    }
  } catch (err) {
    await ctx.reply(`❌ Error: ${err.message}`);
  } finally {
    user.running = false;
    user.cancelRequested = false;
    saveState();
  }
}
