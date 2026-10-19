/**
 * Client LLM OpenAI-compatible (chat completions + function calling).
 *
 * Relay publik sering balas 504 "request_timeout" walau model-nya sehat —
 * upstream-nya intermittent. Karena itu client ini punya tiga lapis
 * pertahanan:
 *
 *   1. Timeout eksplisit per percobaan (AbortController).
 *   2. Retry dengan backoff untuk error sementara (429/502/503/504/timeout).
 *   3. Fallback ke model cadangan kalau model utama tetap gagal.
 *
 * Selain itu ada circuit breaker per model: kalau sebuah model sudah
 * terbukti mati beberapa kali berturut-turut, model itu dilewati dulu
 * selama COOLDOWN_MS supaya tidak buang waktu menunggu timeout lagi.
 */

/** Model cadangan, diurut prioritas. Model utama user selalu dicoba lebih dulu. */
const FALLBACK_MODELS = ['deepseek-v4.1-flash', 'glm-5.3-flash', 'north-mini-code', 'qwen3.8-flash'];

/** Jumlah percobaan per model. */
const MAX_ATTEMPTS_PER_MODEL = 3;

/** Timeout per percobaan (ms). Relay lambat butuh napas. */
const REQUEST_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 90_000);

/** Jeda awal backoff, dilipatgandakan tiap percobaan. */
const BACKOFF_BASE_MS = 1_500;

/** Status HTTP yang layak di-retry. Selain ini = error permanen, langsung gagal. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 507, 509]);

/**
 * Status yang berarti "model ini tidak bisa dipakai" — tidak perlu di-retry,
 * tapi TETAP pantas dicoba ke model cadangan (mis. salah nama model, model
 * nonaktif, atau kuota model itu habis).
 */
const MODEL_UNAVAILABLE_STATUS = new Set([400, 404, 403, 413, 422]);

/**
 * Circuit breaker sederhana per model.
 * key: model -> { failures: number, openedUntil: number }
 */
const breaker = new Map();
const BREAKER_THRESHOLD = 3; // gagal berturut-turut sebelum circuit terbuka
const COOLDOWN_MS = 60_000; // model dilewati selama 1 menit

function breakerOpen(model) {
  const entry = breaker.get(model);
  if (!entry) return false;
  if (Date.now() < entry.openedUntil) return true;
  // cooldown habis: beri kesempatan lagi (half-open)
  if (entry.openedUntil > 0) {
    entry.failures = 0;
    entry.openedUntil = 0;
  }
  return false;
}

function recordFailure(model) {
  const entry = breaker.get(model) ?? { failures: 0, openedUntil: 0 };
  entry.failures += 1;
  if (entry.failures >= BREAKER_THRESHOLD) {
    entry.openedUntil = Date.now() + COOLDOWN_MS;
    console.warn(
      `[llm] circuit breaker terbuka untuk "${model}" selama ${COOLDOWN_MS / 1000}s ` +
        `(${entry.failures} kegagalan berturut-turut).`
    );
  }
  breaker.set(model, entry);
}

function recordSuccess(model) {
  breaker.delete(model);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True kalau error jaringan layak di-retry (timeout / koneksi putus). */
function isRetryableNetworkError(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  const code = err.cause?.code ?? err.code;
  return ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'].includes(
    code
  );
}

/** Satu percobaan request, dengan timeout eksplisit. */
async function singleRequest({ url, token, model, messages, tools }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        model,
        messages,
        ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}),
        temperature: 0.2
      }),
      signal: controller.signal
    });

    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`LLM HTTP ${res.status}: ${text.slice(0, 500)}`);
      err.status = res.status;
      throw err;
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`LLM balikin response non-JSON: ${text.slice(0, 300)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Panggil chat completion dengan retry + fallback model.
 *
 * Urutan percobaan: model utama (dari setting user) lalu fallback yang
 * berbeda dari model utama. Model yang circuit breaker-nya terbuka dilewati.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} opts.token
 * @param {string} opts.model    model utama pilihan user
 * @param {Array}  opts.messages
 * @param {Array}  [opts.tools]
 * @returns {Promise<object>} response JSON mentah
 */
export async function chatCompletion({ baseUrl, token, model, messages, tools }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  // Susun daftar model: utama dulu, lalu fallback yang belum dicoba.
  const candidates = [model, ...FALLBACK_MODELS.filter((m) => m && m !== model)].filter(Boolean);

  let lastErr = null;

  for (const candidate of candidates) {
    if (breakerOpen(candidate)) {
      console.warn(`[llm] "${candidate}" dilewati (circuit breaker masih terbuka).`);
      continue;
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
      try {
        const result = await singleRequest({ url, token, model: candidate, messages, tools });
        recordSuccess(candidate);
        if (candidate !== model) {
          console.warn(`[llm] berhasil pakai model cadangan "${candidate}" (utama: "${model}").`);
        }
        // Tandai model yang benar-benar dipakai supaya agent bisa lapor ke user.
        Object.defineProperty(result, '__usedModel', {
          value: candidate,
          enumerable: false
        });
        return result;
      } catch (err) {
        lastErr = err;

        const retryable = RETRYABLE_STATUS.has(err.status) || isRetryableNetworkError(err) || !err.status;
        const modelUnavailable = MODEL_UNAVAILABLE_STATUS.has(err.status);

        if (!retryable && !modelUnavailable) {
          // 401 = token salah. Retry tidak akan menolong — langsung gagalkan.
          throw err;
        }

        if (modelUnavailable) {
          // Model ini tidak bisa dipakai sama sekali: jangan buang waktu
          // retry, langsung pindah ke model cadangan.
          console.warn(
            `[llm] "${candidate}" tidak tersedia (HTTP ${err.status}). Pindah ke model berikutnya.`
          );
          break;
        }

        const isLastAttempt = attempt === MAX_ATTEMPTS_PER_MODEL;
        if (!isLastAttempt) {
          const delay = BACKOFF_BASE_MS * 2 ** (attempt - 1);
          console.warn(
            `[llm] "${candidate}" percobaan ${attempt}/${MAX_ATTEMPTS_PER_MODEL} gagal ` +
              `(${err.message.slice(0, 120)}). Coba lagi dalam ${delay}ms...`
          );
          await sleep(delay);
        }
      }
    }

    // Semua percobaan untuk model ini gagal -> catat untuk circuit breaker.
    recordFailure(candidate);
    console.warn(`[llm] model "${candidate}" gagal ${MAX_ATTEMPTS_PER_MODEL}x, pindah ke model berikutnya.`);
  }

  throw lastErr ?? new Error('LLM gagal tanpa alasan jelas.');
}

/** Cek koneksi LLM dengan pesan sederhana (dipakai /settings untuk validasi). */
export async function testConnection({ baseUrl, token, model }) {
  const res = await chatCompletion({
    baseUrl,
    token,
    model,
    messages: [{ role: 'user', content: 'Balas dengan satu kata: OK' }]
  });
  return res.choices?.[0]?.message?.content ?? '(kosong)';
}

/** Reset circuit breaker (dipakai test / troubleshooting). */
export function resetBreaker() {
  breaker.clear();
}
