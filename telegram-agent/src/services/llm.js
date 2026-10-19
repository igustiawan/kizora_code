/**
 * Client LLM OpenAI-compatible (chat completions + function calling).
 * Bisa dipakai untuk OpenAI, OpenRouter, DeepSeek, Groq, Ollama, vLLM, dll
 * asalkan endpoint-nya expose POST {baseUrl}/chat/completions.
 */

/**
 * @param {object} opts
 * @param {string} opts.baseUrl  contoh: https://api.openai.com/v1
 * @param {string} opts.token
 * @param {string} opts.model
 * @param {Array}  opts.messages
 * @param {Array}  [opts.tools]
 * @returns {Promise<object>} response JSON mentah
 */
export async function chatCompletion({ baseUrl, token, model, messages, tools }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

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
    })
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`LLM balikin response non-JSON: ${text.slice(0, 300)}`);
  }
}

/**
 * Cek koneksi LLM dengan pesan sederhana (dipakai /settings untuk validasi).
 */
export async function testConnection({ baseUrl, token, model }) {
  const res = await chatCompletion({
    baseUrl,
    token,
    model,
    messages: [{ role: 'user', content: 'Balas dengan satu kata: OK' }]
  });
  return res.choices?.[0]?.message?.content ?? '(kosong)';
}
