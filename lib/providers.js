// Every provider here speaks the OpenAI chat-completions shape, including the
// ones that are not OpenAI: Gemini, Cohere and HuggingFace all publish a
// compatibility endpoint, so one request builder covers the whole roster. That
// is the only reason this file is 60 lines instead of 400.
//
// A provider with no key in the environment is simply absent — the bridge works
// with whatever subset is configured, so it can be deployed with one key and
// grown later without a code change.

export const PROVIDERS = {
  groq:        { env: "GROQ_API_KEY",        url: "https://api.groq.com/openai/v1/chat/completions" },
  mistral:     { env: "MISTRAL_API_KEY",     url: "https://api.mistral.ai/v1/chat/completions" },
  openrouter:  { env: "OPENROUTER_API_KEY",  url: "https://openrouter.ai/api/v1/chat/completions" },
  cerebras:    { env: "CEREBRAS_API_KEY",    url: "https://api.cerebras.ai/v1/chat/completions" },
  cohere:      { env: "COHERE_API_KEY",      url: "https://api.cohere.ai/compatibility/v1/chat/completions" },
  huggingface: { env: "HF_API_KEY",          url: "https://router.huggingface.co/v1/chat/completions" },
  nvidia:      { env: "NVIDIA_API_KEY",      url: "https://integrate.api.nvidia.com/v1/chat/completions" },
  gemini:      { env: "GEMINI_API_KEY",      url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions" },
};

export const configured = () =>
  Object.entries(PROVIDERS).filter(([, p]) => process.env[p.env]).map(([name]) => name);

// An id is "<provider>/<model>", and the model half may itself contain slashes
// (openrouter/qwen/qwen3.8-flash), so split once and keep the remainder whole.
export function splitId(id) {
  const i = id.indexOf("/");
  return i < 0 ? [null, id] : [id.slice(0, i), id.slice(i + 1)];
}

export async function complete(id, messages, maxTokens, timeoutMs = 40000) {
  const [providerName, model] = splitId(id);
  const p = PROVIDERS[providerName];
  if (!p) return { err: "unknown provider in '" + id + "'" };
  const key = process.env[p.env];
  if (!key) return { err: providerName + " has no key configured on this deployment" };

  let res, body;
  try {
    res = await fetch(p.url, {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    body = await res.text();
  } catch (e) {
    return { err: providerName + ": " + String(e.message ?? e).slice(0, 160) };
  }
  if (!res.ok) return { err: providerName + " HTTP " + res.status + ": " + body.slice(0, 200) };

  let j;
  try { j = JSON.parse(body); } catch { return { err: providerName + ": unparseable response" }; }
  if (j.error) return { err: providerName + ": " + String(j.error?.message ?? j.error).slice(0, 200) };

  const raw = j.choices?.[0]?.message?.content ?? "";
  // Same rule as the local ask-free: strip a CLOSED think block only. An
  // unclosed one means the model spent its budget reasoning and never answered,
  // and stripping it would return an empty string that looks like success.
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (!text) {
    const reasoned = j.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    return { err: "empty answer (reasoning_tokens=" + reasoned + ") - retry with a larger max_tokens" };
  }
  return { text, usage: j.usage ?? {}, model: j.model ?? id };
}
