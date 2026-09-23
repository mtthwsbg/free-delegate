#!/usr/bin/env node
// ask-free — send a task to a free model through the local OmniRoute gateway.
//
//   ask-free "task"                     auto: tries each provider in order
//   ask-free -m bulk "task"             alias, or a full id like groq/openai/gpt-oss-120b
//   ask-free -f in.txt "task"           prompt from a file
//   ask-free -o out.md "task"           result to disk, NOT into Claude's context
//   ask-free -s "system" "task"
//   ask-free --list                     show aliases and the live models
//
// Two faults used to make every call fail, both fixed here:
//
//  1. AUTH. /api/* accepts OMNIROUTE_DELEGATE_TOKEN (an admin access token), but
//     /v1/* wants a provisioned API KEY — and the gateway shipped with ZERO keys
//     (/api/keys returned an empty list). So completions failed at the auth layer
//     and surfaced as a 504 upstream timeout, which pointed at the providers
//     rather than at the real cause. The key now lives in ~/.omniroute/.env as
//     OMNIROUTE_API_KEY and is MINTED AUTOMATICALLY when absent, so this cannot
//     silently rot again.
//
//  2. MODEL IDS. Bare names like "gemini-flash-lite-latest" do not resolve. The
//     gateway wants provider/model, and each connection's LIVE catalog is a small
//     subset of the ~1800-entry static one — asking for a model that is in the
//     static list but not the live one returns "not available in the active live
//     catalog". Every alias below was verified against the live catalogs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// console.error is async on Windows; calling process.exit() with writes still
// pending aborts the process with a libuv assertion and yields exit code 127
// instead of 1 -- so a caller cannot tell "provider failed" from "crashed".
// Write synchronously on any path that exits immediately afterwards.
const warn = (msg) => fs.writeSync(2, msg + "\n");
const die  = (msg) => { warn(msg); process.exit(1); };

const BASE = "http://127.0.0.1:20128";
const ENV = path.join(os.homedir(), ".omniroute", ".env");
// Written by free-grow: measured score/latency per provider/model. Read here so
// routing follows evidence instead of a table someone last edited by hand.
const LEDGER  = path.join(os.homedir(), ".omniroute", "probe-ledger.json");
// One JSON line per delegated call. free-stats totals it, so the token ledger in
// a reply is a measurement rather than an estimate.
const SAVINGS = path.join(os.homedir(), ".omniroute", "savings.jsonl");

// Every entry below was probed live and answered. Times are measured, not claimed.
// Five providers are connected; groq/gemini/mistral were the only ones wired up at
// first, which left HuggingFace (136 models) and OpenRouter (398, 18 of them tagged
// :free) completely unused.
const ALIASES = {
  // --- sub-second ---
  // Repointed 2026-09-01 from groq/gpt-oss-120b (62% over 32 calls; 413s on the
  // free TPM cap). Cohere is 4/4 at 763ms and is a general chat model, which is
  // what bulk prose drafting actually wants -- codestral is kept for code.
  bulk:     "groq/openai/gpt-oss-120b", // 6/6 at 634ms (free-grow 2026-09-23, was groq/qwen/qwen3.8-27b)
  fast:     "groq/qwen/qwen3.8-27b", // 5/6 at 342ms (free-grow 2026-09-23, was cohere/command-a-plus-05-2026)
  code:     "mistral/codestral-latest",                          // 0.59s
  glm:      "cohere/command-a-03-2025", // 4/6 at 1006ms (free-grow 2026-09-23, was mistral/codestral-2508)
  big:      "cohere/command-a-plus-05-2026", // 6/6 at 800ms (free-grow 2026-09-23, was groq/openai/gpt-oss-20b)
  // 6/6 on the accuracy set in 1.0s -- the best score-per-second measured on any
  // provider so far, and on a 70B model. Cloudflare needs an Account ID in
  // providerSpecificData as well as the token, or every call 502s.
  llama:    "cloudflare-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast", // 1.0s, 6/6
  // 6/6 in 0.8s and 0.32s on a bare call -- the fastest provider measured.
  cohere:   "cohere/command-r-08-2024", // 4/6 at 331ms (free-grow 2026-09-23, was cohere/command-a-03-2025)
  // --- 1-3s ---
  reason:   "groq/openai/gpt-oss-20b", // 5/6 at 523ms (free-grow 2026-09-23, was openrouter/inclusionai/ling-3.0-flash-fin:free)
  gemma:    "gemini/gemma-4-26b-a4b-it", // 5/6 at 6138ms (free-grow 2026-09-23, was mistral/mistral-code-fim-latest)
  deepseek: "cohere/c4ai-aya-expanse-32b", // 4/6 at 405ms (free-grow 2026-09-23, was huggingface/deepseek-ai/DeepSeek-V4-Flash-0731)
  minimax:  "openrouter/dots-studio/dots-3-note-preview:free", // 4/6 at 4241ms (free-grow 2026-09-23, was openrouter/minimax/minimax-m3:free)
  kimi:     "openrouter/inclusionai/ling-3.0-flash-fin:free", // 5/6 at 1273ms (free-grow 2026-09-23, was mistral/mistral-code-latest)
  qwen:     "openrouter/qwen/qwen3.8-flash",                     // 2.8s
  // NVIDIA: 83 models. Correct 6/6 but 42s on this one -- an alias, not a
  // chain member. Its model ids are NOT the marketing names (kimi-k2.5,
  // glm-4.7 all 400); read the live catalog before picking one.
  nvidia:   "nvidia/deepseek-ai/deepseek-v4-flash-0731",          // 42s, 6/6
  // --- slow, but the heaviest weights available free ---
  ultra:    "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free", // 21s, 550B
  // gemini-2.5-* is retired (404 "no longer available to new users"); 3.7-flash and
  // 3.5-flash-lite both hang past 60s. 3.6 answers but runs 6-14s, so it is no
  // longer the default for quality -- `big` is faster AND larger.
  // Repointed 2026-09-01. Gemini measured 8/17 at a 24.6s median -- slow AND
  // unreliable. Nemotron is 10/11 at 1.9s on a 120B model: better on both axes.
  quality:  "openrouter/nvidia/nemotron-3-super-120b-a12b:free", // 1.9s, 10/11
  gemini:   "gemini/gemini-3.6-flash",                           // 47%, 24.6s - opinion only
};

// Fallback order for -m auto. First that actually answers wins. Deliberately spans
// four different PROVIDERS, because the binding constraint here is RATE LIMITING,
// not availability: hitting groq and huggingface hard in parallel produced 403s on
// models that answered fine seconds earlier. A chain within one provider would fail
// all the way down at exactly the moment load is highest.
// Rebuilt 2026-09-01 from ~/.omniroute/call_logs: every member is >=90% measured
// over its own history, and each is on a DIFFERENT provider so one throttled
// account cannot fail the whole chain. Dropped: groq/gpt-oss-120b (62%),
// cloudflare llama-3.3-70b (40%). Run `free-stats` for the live table.
const CHAIN = [ALIASES.bulk, ALIASES.deepseek, ALIASES.big, ALIASES.code];

// The static CHAIN is the floor, not the law. free-grow writes a measured
// {score, ms, ok} per provider/model into probe-ledger.json; when it has an
// opinion we route by it, so a model that has started failing leaves rotation
// without waiting for a human to notice, and a newly probed model that scores
// better than everything in CHAIN gets tried first. No ledger -> static order,
// which is why this can never make routing worse than it is today.
function ledgerModels() {
  try { return JSON.parse(fs.readFileSync(LEDGER, "utf8")).models ?? {}; } catch { return {}; }
}
function chainOrder() {
  const s = ledgerModels();
  const rank = (id) => [s[id]?.score ?? -1, -(s[id]?.ms ?? 1e9)];
  const healthy = CHAIN.filter(id => s[id]?.ok !== false);
  const bestInChain = Math.max(0, ...CHAIN.map(id => s[id]?.score ?? 0));
  const outsiders = Object.entries(s)
    .filter(([id, v]) => v.ok !== false && !CHAIN.includes(id) && (v.score ?? 0) > 0)
    .sort((a, b) => (b[1].score - a[1].score) || (a[1].ms - b[1].ms))
    .map(([id]) => id);
  const promoted = outsiders.filter(id => (s[id].score ?? 0) > bestInChain);
  const order = [
    ...promoted,
    ...healthy.sort((a, b) => (rank(b)[0] - rank(a)[0]) || (rank(b)[1] - rank(a)[1])),
    ...outsiders.filter(id => !promoted.includes(id)),
  ];
  return order.length ? order : CHAIN;
}

/*
  Scored 6/6 on a mechanically-checked accuracy set (date arithmetic, percentages,
  JS semantics, SQL, money):

    deepseek  1.7s   <- fastest correct
    kimi      3.3s
    big       3.6s
    quality  25.4s   <- same score, 15x slower. Gemini is NOT the quality option.

  So `quality` is kept only as a differently-weighted opinion for a panel, never as
  a first choice. Accuracy did not track size or latency at all.
*/

// Panels for --panel: run several models on the same prompt AT ONCE and keep every
// answer, so the best can be chosen rather than hoped for. Members are drawn from
// different model families on purpose -- three checkpoints of the same base model
// agree with each other and tell you nothing.
const PANELS = {
  // At most ONE model per provider per panel. Two HuggingFace models fired together
  // returned 403 on a model that had answered 200 seconds earlier -- free tiers
  // throttle per account, so stacking a panel on one provider throttles itself.
  // 2026-09-01: llama (cloudflare, 40%) dropped from every panel. A panel member
  // that fails 3 times in 5 does not add an opinion, it adds latency.
  fast:  [ALIASES.bulk, ALIASES.deepseek, ALIASES.big],           // cohere + HF + openrouter
  broad: [ALIASES.bulk, ALIASES.deepseek, ALIASES.big, ALIASES.code, ALIASES.qwen],
  code:  [ALIASES.code, ALIASES.deepseek, ALIASES.bulk, ALIASES.qwen],
  max:   [ALIASES.ultra, ALIASES.kimi, ALIASES.bulk, ALIASES.code, ALIASES.qwen],
};

const args = process.argv.slice(2);
let model = "auto", inFile = null, outFile = null, system = null, maxTok = 2048, list = false, panel = null, summarize = 0;
const rest = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-m" || a === "--model") model = args[++i];
  else if (a === "-f" || a === "--file") inFile = args[++i];
  else if (a === "-o" || a === "--out") outFile = args[++i];
  else if (a === "-s" || a === "--system") system = args[++i];
  else if (a === "--max") maxTok = parseInt(args[++i], 10);
  else if (a === "--list") list = true;
  else if (a === "--panel") panel = args[++i] ?? "fast";
  else if (a === "--summarize") summarize = parseInt(args[++i] ?? "8", 10) || 8;
  else rest.push(a);
}

function envVal(name) {
  try {
    const m = fs.readFileSync(ENV, "utf8").match(new RegExp("^" + name + "=(.+)$", "m"));
    return m ? m[1].trim() : null;
  } catch { return null; }
}

async function health() {
  try {
    const r = await fetch(BASE + "/api/monitoring/health", { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch { return false; }
}

async function ensureGateway() {
  if (await health()) return true;
  warn("[ask-free] gateway not up - starting it (up to 60s)...");
  const { spawn } = await import("node:child_process");
  // Call node on the entry point, not the bare name: on Windows the .ps1 shim
  // opens in an editor instead of running.
  const entry = path.join(process.env.APPDATA ?? "", "npm", "node_modules", "omniroute", "bin", "omniroute.mjs");
  spawn(process.execPath, [entry, "serve", "--daemon", "--no-open", "--no-tray"],
        { stdio: "ignore", detached: true }).unref();
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    if (await health()) return true;
  }
  return false;
}

// The step whose absence broke everything. Self-healing on purpose.
async function ensureApiKey() {
  let key = envVal("OMNIROUTE_API_KEY");
  if (key) return key;
  const tok = envVal("OMNIROUTE_DELEGATE_TOKEN");
  if (!tok) throw new Error("OMNIROUTE_DELEGATE_TOKEN missing from ~/.omniroute/.env");
  const r = await fetch(BASE + "/api/keys", {
    method: "POST",
    headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "claude-code-delegate" }),
  });
  if (!r.ok) throw new Error("could not mint an API key: HTTP " + r.status + " " + (await r.text()).slice(0, 200));
  key = (await r.json()).key;
  fs.appendFileSync(ENV, "\nOMNIROUTE_API_KEY=" + key + "\n");
  warn("[ask-free] minted a /v1 API key and saved it to ~/.omniroute/.env");
  return key;
}

if (!(await ensureGateway())) {
  warn("[ask-free] gateway would not start; do the work locally instead.");
  process.exit(1);
}
const KEY = await ensureApiKey();

if (list) {
  console.log("aliases:");
  for (const [k, v] of Object.entries(ALIASES)) console.log("  " + k.padEnd(8) + " " + v);
  const tok = envVal("OMNIROUTE_DELEGATE_TOKEN");
  const conns = await fetch(BASE + "/api/providers", { headers: { Authorization: "Bearer " + tok } }).then(r => r.json());
  console.log("\nlive models per active connection:");
  for (const c of conns.connections.filter(x => x.isActive)) {
    const m = await fetch(BASE + "/api/providers/" + c.id + "/models", { headers: { Authorization: "Bearer " + tok } })
      .then(r => r.json()).catch(() => ({ models: [] }));
    const ids = (m.models ?? []).slice(0, 6).map(x => x.id).join(", ");
    console.log("  " + c.provider + " (" + (m.models?.length ?? 0) + "): " + ids);
  }
  process.exit(0);
}

let prompt = rest.join(" ");
if (inFile) prompt = fs.readFileSync(inFile, "utf8") + (prompt ? "\n\n" + prompt : "");
if (!prompt.trim()) {
  warn('usage: ask-free [-m alias|provider/model] [-f in] [-o out] [-s system] [--summarize N] "task"   (--list for models)');
  process.exit(2);
}

const messages = [];
if (system) messages.push({ role: "system", content: system });
messages.push({ role: "user", content: prompt });

// Append-only receipt. Never throws: a failed write must not fail a good call.
function record(id, usage, ms, ok) {
  try {
    fs.appendFileSync(SAVINGS, JSON.stringify({
      ts: new Date().toISOString(), model: id, ms, ok,
      in: usage?.prompt_tokens ?? 0, out: usage?.completion_tokens ?? 0,
    }) + String.fromCharCode(10));
  } catch { /* a missing receipt is not worth losing the answer over */ }
}

async function call(id, msgs = messages, budget = maxTok) {
  const res = await fetch(BASE + "/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ model: id, messages: msgs, max_tokens: budget }),
    // 45s, was 300s. Every historical "hang" was this: a provider that never
    // starts responding held the caller for five minutes. A free model that has
    // not begun in 45s is not going to.
    signal: AbortSignal.timeout(45000),
  });
  const body = await res.text();
  if (!res.ok) return { err: "HTTP " + res.status + ": " + body.slice(0, 200) };
  let j;
  try { j = JSON.parse(body); } catch { return { err: "unparseable: " + body.slice(0, 200) }; }
  if (j.error) return { err: String(j.error?.message ?? j.error).slice(0, 200) };

  const raw = j.choices?.[0]?.message?.content ?? "";
  const finish = j.choices?.[0]?.finish_reason ?? "";
  // Strip only a CLOSED <think> block. An unclosed one means the model spent its
  // whole budget reasoning and never answered; stripping it would yield an empty
  // file that looks like success.
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^\s*\n/, "").trim();
  if (!text) {
    const reasoned = j.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    return { err: "empty answer (finish=" + finish + ", reasoning_tokens=" + reasoned + ") - retry with --max " + (budget * 2) };
  }
  return { text, finish, usage: j.usage ?? {}, model: j.model ?? id };
}

// ---- panel mode: several models, at once, all answers kept --------------------
//
// Sequential fallback asks "did one work". A panel asks "which one did it BEST",
// which is a different and usually more valuable question -- and because the calls
// overlap, N answers cost about as much wall-clock as the slowest single one.
// Nothing here reaches Claude's context: every answer goes to its own file and only
// the summary table is printed.
if (panel) {
  const requested = PANELS[panel] ?? panel.split(",").map(s => ALIASES[s.trim()] ?? s.trim());
  // Drop members the ledger has measured as DOWN. A panel exists to collect
  // several opinions; a member that 401s contributes no opinion and only adds
  // latency to the slowest-member wall clock. Never drop the last one standing:
  // an empty panel is a worse answer than a doubtful one.
  const sick = ledgerModels();
  const live = requested.filter(id => sick[id]?.ok !== false);
  const members = live.length ? live : requested;
  if (members.length !== requested.length) {
    warn("[ask-free] panel '" + panel + "': skipping " + (requested.length - members.length) +
         " member(s) measured as down (free-grow --report for why)");
  }
  if (!outFile) {
    warn("[ask-free] --panel needs -o FILE; each model writes FILE.<n>.<slug>");
    process.exit(2);
  }
  const started = Date.now();
  const results = await Promise.all(members.map(async (id, i) => {
    const t0 = Date.now();
    const r = await call(id);
    const ms = Date.now() - t0;
    record(id, r.usage, ms, Boolean(r.text));
    return { id, i, ms, ...r };
  }));

  const base = path.resolve(outFile);
  fs.mkdirSync(path.dirname(base), { recursive: true });
  warn("[ask-free] panel '" + panel + "' - " + members.length +
                " models in " + ((Date.now() - started) / 1000).toFixed(1) + "s wall clock");
  let okCount = 0, produced = 0;
  for (const r of results.sort((a, b) => a.ms - b.ms)) {
    const slug = r.id.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(-40);
    if (r.text) {
      okCount++;
      produced += r.usage?.completion_tokens ?? 0;
      const f = base + "." + r.i + "." + slug;
      fs.writeFileSync(f, r.text);
      warn("  " + String(r.ms).padStart(6) + "ms  ok    " +
                    String(r.usage?.completion_tokens ?? "?").padStart(5) + " out  " + f);
    } else {
      warn("  " + String(r.ms).padStart(6) + "ms  FAIL  " + r.id + " - " + r.err.slice(0, 70));
    }
  }
  warn("[ask-free] " + okCount + "/" + members.length + " answered | " +
                produced + " tokens produced | Anthropic tokens billed: 0");
  if (!okCount) process.exit(1);
  console.log("OK: " + okCount + " answers written beside " + base + " (none loaded into context)");
  process.exit(0);
}

const wanted = model === "auto" ? chainOrder() : [ALIASES[model] ?? model];

// Failure budget. Without one, a bad day walks the whole chain and the caller
// waits minutes for a result that was never coming -- which is exactly how two
// sessions concluded "the gateway is dead" when the gateway was fine and the
// chain was misrouted. Two consecutive failures is enough evidence: stop, and
// say WHICH providers failed and why, so the next run fixes routing instead of
// re-running the same doomed chain.
const BUDGET = 2;
let out = null;
const tried = [];
for (const id of wanted) {
  const t0 = Date.now();
  const r = await call(id);
  record(id, r.usage, Date.now() - t0, Boolean(r.text));
  if (r.text) { out = r; break; }
  tried.push(id + ": " + r.err);
  warn("[ask-free] " + id + " failed - " + r.err);
  if (tried.length >= BUDGET) {
    warn("[ask-free] failure budget spent (" + BUDGET + " providers). Stopping.");
    break;
  }
}
if (!out) {
  warn("[ask-free] gave up after " + tried.length + " provider(s): " + tried.join(" | "));
  warn("[ask-free] run `free-stats` for measured success rates before retrying.");
  // NOT process.exit(). On Windows/Node 24, exiting while undici still holds an
  // idle keep-alive socket aborts with a libuv assertion and reports 127, so the
  // caller cannot tell a provider failure from a crash. Setting exitCode lets the
  // loop drain and exit 1 cleanly.
  process.exitCode = 1;
} else {

const u = out.usage;
if (out.finish === "length") {
  warn("[ask-free] WARNING: truncated at " + maxTok + " tokens - rerun with a larger --max.");
}
warn("[ask-free] " + out.model + " | in " + (u.prompt_tokens ?? "?") +
              " | out " + (u.completion_tokens ?? "?") + " | Anthropic tokens billed: 0");

if (outFile) {
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, out.text);
  warn("[ask-free] wrote " + out.text.length + " chars -> " + outFile);
  if (summarize) {
    // The last hole in the protocol: the artifact was generated for free, then
    // read back by Claude at full price. A SECOND free model compresses it, so
    // only N lines ever enter the context and the file stays complete on disk.
    const sys = "You compress documents for an engineer who will act on them. Output at most " +
      summarize + " lines, each a complete standalone statement of fact from the text. " +
      "No preamble, no markdown headings, no invented detail.";
    const t0 = Date.now();
    const sum = await call(ALIASES.bulk, [
      { role: "system", content: sys },
      { role: "user", content: out.text.slice(0, 60000) },
    ], Math.max(256, summarize * 120));
    record(ALIASES.bulk, sum.usage, Date.now() - t0, Boolean(sum.text));
    if (sum.text) {
      const lines = sum.text.split(/\r?\n/).filter(l => l.trim()).slice(0, summarize);
      warn("[ask-free] summarized by " + (sum.model ?? ALIASES.bulk) + " | Anthropic tokens billed: 0");
      console.log(lines.join(String.fromCharCode(10)));
      console.log("(full " + out.text.length + " chars in " + outFile + ", not loaded into context)");
    } else {
      // Say so rather than printing nothing: a silent empty summary looks like
      // an empty artifact, and the file is fine.
      warn("[ask-free] summary failed (" + sum.err + ") - the file itself is intact.");
      console.log("OK: " + outFile + " (" + out.text.length + " chars; summary failed, not loaded into context)");
    }
  } else {
    console.log("OK: " + outFile + " (" + out.text.length + " chars, not loaded into context)");
  }
} else {
  console.log(out.text);
}
}
