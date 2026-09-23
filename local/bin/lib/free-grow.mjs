#!/usr/bin/env node
// free-grow — grow the free-model roster without being asked to.
//
//   free-grow --probe            discover untried models, score them, act on it
//   free-grow --probe --dry-run  same, but change nothing (prints the diff)
//   free-grow --limit 20         probe more per run (default 12)
//   free-grow --acquire          wire up providers whose credential we already hold
//   free-grow --report           print the current ledger, probe nothing
//   free-grow --revert           restore ask-free.mjs from the last snapshot
//
// Why this exists: `free-scout` reports what is unused and waits for a human.
// Five connected providers expose 500+ models and almost none have ever been
// called, so "waits for a human" means the capacity is never used. This probes
// it, scores it MECHANICALLY (no model judges another model), and rewrites
// ask-free's ALIASES itself. Every mutation is snapshotted and reversible.
//
// It costs zero Anthropic tokens: it talks only to the local gateway and to free
// providers, and writes files. Claude never reads what it produces unless the
// report says something changed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const BASE      = "http://127.0.0.1:20128";
const HOME      = os.homedir();
const ENV       = path.join(HOME, ".omniroute", ".env");
const LOGS      = path.join(HOME, ".omniroute", "call_logs");
const LEDGER    = path.join(HOME, ".omniroute", "probe-ledger.json");
const STAMP     = path.join(HOME, ".omniroute", ".last-grow");
const ASKFREE   = path.join(HOME, ".claude", "bin", "lib", "ask-free.mjs");
const OPTDIR    = path.join(HOME, ".claude", "optimize");
const SNAPDIR   = path.join(OPTDIR, "applied");
const CHANGELOG = path.join(OPTDIR, "free-grow-ledger.md");
const QUEUE     = path.join(OPTDIR, "signup-queue.md");

const log = (m) => fs.writeSync(1, m + "\n");
const warn = (m) => fs.writeSync(2, m + "\n");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const DRY   = has("--dry-run");
const LIMIT = parseInt(val("--limit", "12"), 10) || 12;
// A wall-clock budget, because a probe's cost is not the model count: one
// provider that swallows 25s per question turns a 12-model run into half an
// hour. Whatever has been measured when the budget runs out is still written --
// a partial ledger is useful, an unbounded background job is not.
const DEADLINE = (parseInt(val("--deadline", "300"), 10) || 300) * 1000;
const START = Date.now();

// ---------------------------------------------------------------- gateway ----
function envVal(name) {
  try {
    const m = fs.readFileSync(ENV, "utf8").match(new RegExp("^" + name + "=(.+)$", "m"));
    return m ? m[1].trim() : null;
  } catch { return null; }
}
async function health() {
  try { return (await fetch(BASE + "/api/monitoring/health", { signal: AbortSignal.timeout(4000) })).ok; }
  catch { return false; }
}
async function ensureGateway() {
  if (await health()) return true;
  warn("[free-grow] starting the gateway...");
  const entry = path.join(process.env.APPDATA ?? "", "npm", "node_modules", "omniroute", "bin", "omniroute.mjs");
  spawn(process.execPath, [entry, "serve", "--daemon", "--no-open", "--no-tray"],
        { stdio: "ignore", detached: true }).unref();
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    if (await health()) return true;
  }
  return false;
}
async function apiKey() {
  let key = envVal("OMNIROUTE_API_KEY");
  if (key) return key;
  const tok = envVal("OMNIROUTE_DELEGATE_TOKEN");
  const r = await fetch(BASE + "/api/keys", {
    method: "POST",
    headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "free-grow" }),
  });
  if (!r.ok) throw new Error("could not mint an API key: HTTP " + r.status);
  key = (await r.json()).key;
  fs.appendFileSync(ENV, "\nOMNIROUTE_API_KEY=" + key + "\n");
  return key;
}

// ------------------------------------------------------------- the ledger ----
const loadLedger = () => {
  try { return JSON.parse(fs.readFileSync(LEDGER, "utf8")); }
  catch { return { version: 1, updated: null, models: {} }; }
};
const saveLedger = (l) => {
  l.updated = new Date().toISOString();
  fs.writeFileSync(LEDGER, JSON.stringify(l, null, 1));
};

// --------------------------------------------------------- the accuracy set --
// Mechanically checkable on purpose. A model grading another model is how you
// end up routing on confidence rather than correctness — every answer here is
// compared to a fixed string, so a wrong answer cannot talk its way through.
// Questions are deliberately cheap: the point is to disqualify, not to rank
// deeply, and a 6-question set costs a free provider nothing.
const QUIZ = [
  { q: "What is 17% of 240? Reply with only the number.",                                       a: ["40.8"] },
  { q: "How many days are there from 2024-02-27 to 2024-03-02 inclusive? Reply with only the number.", a: ["5"] },
  { q: "In JavaScript, what does [10,9,1].sort() return? Reply with only the array literal.",    a: ["[1,10,9]", "[ 1, 10, 9 ]"] },
  { q: "SQL: SELECT COUNT(*) FROM t WHERE x IS NULL; with rows x = 1, NULL, NULL, 3. Reply with only the number.", a: ["2"] },
  { q: "An item costs $18.50 and there is 7% tax. What is the total in dollars? Reply with only the number.", a: ["19.795", "19.80", "19.8"] },
  { q: "Which is larger, 0.9 or 0.85? Reply with only the number.",                              a: ["0.9"] },
];
const norm = (s) => String(s).toLowerCase().replace(/[\s,$"'`*]/g, "").replace(/[.]$/, "");
const graded = (answer, accepted) => {
  const got = norm(answer).slice(-40);
  return accepted.some(a => got.endsWith(norm(a)) || got === norm(a));
};

async function probe(KEY, id) {
  let score = 0, total = 0;
  const t0 = Date.now();
  for (const item of QUIZ) {
    let body;
    try {
      const res = await fetch(BASE + "/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: id,
          messages: [{ role: "user", content: item.q }],
          max_tokens: 400,
        }),
        signal: AbortSignal.timeout(25000),
      });
      body = await res.text();
      if (!res.ok) return { ok: false, err: "HTTP " + res.status + " " + body.slice(0, 90), score: 0, ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, err: String(e.message ?? e).slice(0, 90), score: 0, ms: Date.now() - t0 };
    }
    let j; try { j = JSON.parse(body); } catch { return { ok: false, err: "unparseable", score: 0, ms: Date.now() - t0 }; }
    if (j.error) return { ok: false, err: String(j.error?.message ?? j.error).slice(0, 90), score: 0, ms: Date.now() - t0 };
    const raw = j.choices?.[0]?.message?.content ?? "";
    // Same rule as ask-free: only a CLOSED think block is noise. An unclosed one
    // means the model never got to an answer, which is a failed question.
    const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    total++;
    if (text && graded(text, item.a)) score++;
  }
  return { ok: total > 0, score, max: QUIZ.length, ms: Math.round((Date.now() - t0) / QUIZ.length) };
}

// ------------------------------------------------- what ask-free routes to ---
function readAliases() {
  const src = fs.readFileSync(ASKFREE, "utf8");
  const map = new Map();
  for (const m of src.matchAll(/^\s{2}(\w+):\s+"([^"]+)"/gm)) map.set(m[1], m[2]);
  return map;
}
// Only these may be taken over automatically. `code`, `quality` and `ultra` are
// chosen for a KIND of work, not a score — a general model that outscores
// codestral on arithmetic is not a better code model, and swapping it in on that
// evidence would be exactly the kind of confident wrong call this whole setup
// exists to avoid. They stay report-only.
const GENERAL = ["bulk", "fast", "big", "reason", "deepseek", "minimax", "kimi", "qwen", "glm", "gemma", "llama", "cohere"];
// `fast` names a LATENCY promise, so ranking it score-first is wrong: a run
// replaced a 523ms holder with an 800ms one for a single extra quiz mark, which
// is the opposite of what anyone typing -m fast is asking for. Among candidates
// that clear the floor, this alias sorts on speed and uses score only to break
// a tie. Every other alias stays score-first.
const LATENCY_FIRST = new Set(["fast"]);
// Code specialists belong on `code` and nowhere else. A rescue once put
// codestral on `glm` and mistral-code on `kimi` because both cleared the quiz
// floor -- but the quiz is arithmetic and SQL, which a code model is good at, so
// the floor cannot tell a code model from a general one. That judgement has to
// come from the model's name, the one signal available before it is in use.
const CODE_MODEL = /codestral|devstral|[-/]code[-/]|coder|code-latest/i;
// Most of those alias names are a CONTRACT about which model family answers, not
// just a label: panels are built from different families on purpose, and three
// checkpoints of one base model agreeing teaches nothing. So a family-named
// alias may only be taken over by a model of that family. `bulk`, `fast`, `big`
// and `reason` name a job rather than a family and are open to anyone.
// The exception is a DEAD holder: a correctly-named alias that 401s is worse
// than a working one whose name no longer matches, so a rescue ignores family.
const FAMILY = {
  cohere:   /cohere|command-/i,
  llama:    /llama/i,
  glm:      /glm|zai-org/i,
  gemma:    /gemma/i,
  deepseek: /deepseek/i,
  minimax:  /minimax/i,
  kimi:     /kimi|moonshot/i,
  qwen:     /qwen/i,
};
const SKIP_MODEL = /embed|whisper|tts|speech|audio|image|vision|rerank|guard|moderat|bge|clip|sdxl|flux|stable-|diffusion|ocr|translate|transcri|fim|-base$/i;

// ----------------------------------------------- measured health from logs ---
function successRates() {
  const stat = new Map();
  if (!fs.existsSync(LOGS)) return stat;
  for (const day of fs.readdirSync(LOGS)) {
    const dir = path.join(LOGS, day);
    let st; try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      let s; try { s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).summary; } catch { continue; }
      if (!s) continue;
      const model = s.model ?? s.requestedModel ?? "?";
      // The gateway logs its own housekeeping through the same call log:
      // `model-sync` is a catalogue refresh and `connection-test` is the
      // credential check fired by /providers/:id/test. Neither is inference, and
      // counting them invented nine 0%-success "models" that the demotion pass
      // then dutifully demoted. Anything that is not a real model id is noise.
      if (model === "model-sync" || model === "connection-test") continue;
      const key = (s.provider ?? "?") + "/" + model;
      const e = stat.get(key) ?? { ok: 0, n: 0 };
      e.n++; if (s.status === 200) e.ok++;
      stat.set(key, e);
    }
  }
  return stat;
}

// ------------------------------------------------------------- the catalog ---
async function catalog() {
  const tok = envVal("OMNIROUTE_DELEGATE_TOKEN");
  const conns = await fetch(BASE + "/api/providers", { headers: { Authorization: "Bearer " + tok } })
    .then(r => r.json());
  const out = [];
  for (const c of (conns.connections ?? []).filter(x => x.isActive)) {
    const m = await fetch(BASE + "/api/providers/" + c.id + "/models", { headers: { Authorization: "Bearer " + tok } })
      .then(r => r.json()).catch(() => ({ models: [] }));
    for (const model of (m.models ?? [])) {
      const id = c.provider + "/" + model.id;
      // OpenRouter's catalogue is mostly PAID models. A paid model on an account
      // with no credit does not fail loudly, it fails after a round trip — so
      // filter on the ':free' tag the provider itself publishes rather than
      // discovering it one 402 at a time.
      if (c.provider === "openrouter" && !/:free$/.test(model.id)) continue;
      if (SKIP_MODEL.test(model.id)) continue;
      out.push({ id, provider: c.provider });
    }
  }
  return out;
}

// ------------------------------------------------------------------ actions --
function snapshot() {
  fs.mkdirSync(SNAPDIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(SNAPDIR, "ask-free." + stamp + ".mjs");
  fs.copyFileSync(ASKFREE, dest);
  return dest;
}
// Taken lazily, but always BEFORE the first byte is changed. Snapshotting after
// the edits captured the mutated file and made --revert a no-op that looked like
// it worked -- the worst possible failure for a safety net.
let SNAPPED = null;
function ensureSnapshot() {
  if (!SNAPPED) SNAPPED = snapshot();
  return SNAPPED;
}
function repoint(alias, from, to, note) {
  const src = fs.readFileSync(ASKFREE, "utf8");
  const re = new RegExp("^(\\s{2}" + alias + ":\\s+)\"" + from.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&") + "\"(.*)$", "m");
  if (!re.test(src)) return false;
  ensureSnapshot();
  const today = new Date().toISOString().slice(0, 10);
  const replacement = "$1\"" + to + "\", // " + note + " (free-grow " + today + ", was " + from + ")";
  fs.writeFileSync(ASKFREE, src.replace(re, replacement));
  return true;
}
function appendChangelog(lines) {
  fs.mkdirSync(OPTDIR, { recursive: true });
  const head = "\n## " + new Date().toISOString().slice(0, 16).replace("T", " ") + "\n\n";
  fs.appendFileSync(CHANGELOG, head + lines.map(l => "- " + l).join("\n") + "\n");
}

// -------------------------------------------------------------------- main ---
if (has("--revert")) {
  // Only files THIS tool wrote, matched on its own timestamped naming. A
  // hand-made backup sitting in the same folder ("ask-free.mjs.before-reroute")
  // sorted last under a plain prefix match and a revert restored a version from
  // weeks earlier, silently undoing unrelated work. A restore point has to be
  // one we know the provenance of.
  const snaps = fs.existsSync(SNAPDIR)
    ? fs.readdirSync(SNAPDIR).filter(f => /^ask-free\.\d{4}-\d{2}-\d{2}T[\d-]+Z\.mjs$/.test(f)).sort()
    : [];
  if (!snaps.length) { warn("[free-grow] no snapshot to revert to."); process.exit(1); }
  const last = path.join(SNAPDIR, snaps[snaps.length - 1]);
  fs.copyFileSync(last, ASKFREE);
  log("reverted ask-free.mjs from " + last);
  appendChangelog(["REVERTED ask-free.mjs from " + path.basename(last)]);
  process.exit(0);
}

if (has("--report")) {
  const l = loadLedger();
  const rows = Object.entries(l.models).sort((a, b) => (b[1].score - a[1].score) || (a[1].ms - b[1].ms));
  log("\nprobe ledger (" + rows.length + " models, updated " + (l.updated ?? "never") + ")\n");
  for (const [id, v] of rows.slice(0, 40)) {
    log("  " + (v.ok ? String(v.score) + "/" + (v.max ?? 6) : "FAIL").padEnd(6) +
        String(v.ms ?? "?").padStart(7) + "ms  " + id + (v.err ? "   " + v.err : ""));
  }
  log("");
  process.exit(0);
}

if (has("--acquire")) {
  // The provider list is curated BY HAND in signup-queue.md now, and this only
  // reads it. The generated version was wrong on four of seven entries within
  // a week (trials sold as free tiers, a shut-down service), and the check it
  // ran on GitHub Models treated any 200 as success -- the dead endpoint now
  // answers every request with a bare 200 "OK". Whether a provider is really
  // free is a judgement that needs a person or a fresh source, not a status code.
  const text = fs.existsSync(QUEUE) ? fs.readFileSync(QUEUE, "utf8") : "";
  if (!text) { log("no signup queue at " + QUEUE); process.exit(0); }
  const worth = text.split(/^## /m).find((sec) => sec.startsWith("Worth doing")) ?? "";
  const names = [...worth.matchAll(/^- [*][*]([^*]+)[*][*]/gm)].map((m) => m[1]);
  log(names.length
    ? "worth a signup: " + names.join(", ") + "  (details: " + QUEUE + ")"
    : "nothing worth a signup right now (" + QUEUE + ")");
  process.exit(0);
}

// ---- the probe run ----------------------------------------------------------
if (!(await ensureGateway())) { warn("[free-grow] gateway would not start."); process.exit(1); }
const KEY = await apiKey();

const ledger = loadLedger();
const aliases = readAliases();
const rates = successRates();
const all = await catalog();

// Current alias holders always get probed when unmeasured: a promotion decision
// needs BOTH sides measured, and "challenger scored 6/6" says nothing without
// the incumbent's number next to it.
const holders = [...new Set(aliases.values())].filter(id => !ledger.models[id]);
const untried = all.map(m => m.id).filter(id => !ledger.models[id] && !holders.includes(id));

const picked = [...holders];
// Round-robin across providers so one provider's free tier is never hammered,
// and so a 398-model catalogue cannot starve a 3-model one out of the run.
const byProvider = new Map();
for (const id of untried) {
  const p = id.split("/")[0];
  if (!byProvider.has(p)) byProvider.set(p, []);
  byProvider.get(p).push(id);
}
outer: while (picked.length < LIMIT + holders.length) {
  let added = false;
  for (const [, list] of byProvider) {
    if (!list.length) continue;
    picked.push(list.shift()); added = true;
    if (picked.length >= LIMIT + holders.length) break outer;
  }
  if (!added) break;
}

log("[free-grow] catalogue " + all.length + " usable models | " + untried.length + " never probed | " +
    "probing " + picked.length + " (" + holders.length + " incumbents)" + (DRY ? " [dry run]" : ""));

// One model per provider in flight. Free tiers throttle per ACCOUNT, so firing
// two of a provider's models at once makes that provider look broken — the same
// lesson panels already learned.
const groups = new Map();
for (const id of picked) {
  const p = id.split("/")[0];
  if (!groups.has(p)) groups.set(p, []);
  groups.get(p).push(id);
}
const results = [];
await Promise.all([...groups.entries()].map(async ([, ids]) => {
  for (const id of ids) {
    if (Date.now() - START > DEADLINE) {
      log("  (deadline reached — " + id + " and the rest of " + id.split("/")[0] + " left for next run)");
      break;
    }
    const r = await probe(KEY, id);
    results.push({ id, ...r });
    log("  " + (r.ok ? (r.score + "/" + r.max) : "FAIL ").padEnd(6) +
        String(r.ms ?? "?").padStart(7) + "ms  " + id + (r.err ? "  " + r.err : ""));
  }
}));

for (const r of results) {
  ledger.models[r.id] = {
    score: r.score ?? 0, max: r.max ?? QUIZ.length, ms: r.ms ?? null,
    ok: Boolean(r.ok), err: r.err ?? null, ts: new Date().toISOString().slice(0, 10),
  };
}

// Health from real traffic overrides a good probe: a model that answers a quiz
// but fails 4 of 5 real calls is not usable, and the call log is the only place
// that knows.
const changes = [];
for (const [id, e] of rates) {
  if (e.n >= 3 && e.ok / e.n < 0.8 && ledger.models[id]?.ok !== false) {
    ledger.models[id] = { ...(ledger.models[id] ?? { score: 0, max: QUIZ.length, ms: null }), ok: false,
                          err: "measured " + Math.round(100 * e.ok / e.n) + "% over " + e.n + " calls" };
    changes.push("demoted `" + id + "` — " + Math.round(100 * e.ok / e.n) + "% over " + e.n + " real calls");
  }
}

// Promotions. Score first, then latency, and a tie needs a 30% speed win before
// anything moves — churn between two equally good models is noise that makes the
// routing table impossible to reason about later.
// One model may claim at most ONE alias per run. Without this the single best
// scorer sweeps every alias and the roster silently becomes one model wearing
// six names -- which is the exact opposite of what a roster is for.
const claimed = new Set([...aliases.values()]);
// Aliases that will need a rescue this pass. A family member is only reserved
// for an alias in this set -- reserving it for a HEALTHY family alias left
// `kimi` and `glm` with nothing, because almost every candidate matches some
// family whose own alias did not need it.
const needy = new Set(GENERAL.filter(a => {
  const h = aliases.get(a);
  return h && (!ledger.models[h] || ledger.models[h].ok === false || CODE_MODEL.test(h));
}));
// A rescue replaces a dead alias, and a dead alias is still better than a live
// one that gets the answer wrong: "it responded" is not the bar. Nothing below
// half marks may hold an alias, however broken the incumbent is. Observed: a
// 1/6 model was installed as `reason` purely because the holder was 401ing.
const FLOOR = QUIZ.length / 2;
for (const alias of GENERAL) {
  const cur = aliases.get(alias);
  if (!cur) continue;
  const held = ledger.models[cur];
  // A code model holding a general alias is misplaced even if it answers --
  // treat it like a dead holder so the rescue path replaces it. Without this
  // the CODE_MODEL rule only stopped NEW mistakes and left the existing ones
  // in rotation forever, because an incumbent is never re-checked as a candidate.
  const misplaced = CODE_MODEL.test(cur);
  const dead = !held || held.ok === false || misplaced;
  const fam = FAMILY[alias];
  let best = null;
  for (const [id, v] of Object.entries(ledger.models)) {
    if (!v.ok || id === cur || claimed.has(id)) continue;
    if (v.score < FLOOR) continue;
    if (CODE_MODEL.test(id)) continue;          // general aliases only; see CODE_MODEL
    // Never take a model that is the rightful family member of ANOTHER family
    // alias. Observed: `kimi` (processed first) rescued itself onto the only
    // Gemma model in the ledger, leaving `gemma` with nothing to be rescued to.
    // Loop order decided who won; the family contract should.
    const ownedElsewhere = Object.entries(FAMILY).some(([other, re]) =>
      other !== alias && needy.has(other) && re.test(id));
    if (ownedElsewhere && !(fam && fam.test(id))) continue;
    if (fam && !dead && !fam.test(id)) continue;          // the name is a contract
    const speedAlias = LATENCY_FIRST.has(alias);
    const better = dead
      ? true
      : speedAlias
        // clearly faster, and no worse than one mark down
        ? (v.ms < held.ms * 0.8 && v.score >= held.score - 1)
        : (v.score > held.score || (v.score === held.score && v.ms < held.ms * 0.7));
    if (!better) continue;
    // A rescue prefers a same-family replacement when one is available, so the
    // alias keeps meaning what it says wherever that is still possible.
    const famBonus = (fam && fam.test(id)) ? 1 : 0;
    const rank = (x, b) => speedAlias
      ? [-x.ms, x.score + b * 0.5]
      : [x.score + b * 0.5, -x.ms];
    if (!best) { best = { id, v, b: famBonus }; continue; }
    const [as, am] = rank(v, famBonus), [bs, bm] = rank(best.v, best.b);
    if (as > bs || (as === bs && am > bm)) best = { id, v, b: famBonus };
  }
  if (!best) {
    if (dead) changes.push("`" + alias + "` -> " + cur + (misplaced
      ? " is a code model on a general alias"
      : " is DOWN (" + (held?.err ?? "never answered") + ")") +
      " and nothing measured can replace it yet");
    continue;
  }
  const note = best.v.score + "/" + best.v.max + " at " + best.v.ms + "ms";
  const why = misplaced ? "code model on a general alias" : dead ? "RESCUE, holder down: " + (held?.err ?? "unmeasured") : "was " +
              held.score + "/" + held.max + " at " + held.ms + "ms";
  if (DRY) { changes.push("[dry] would repoint `" + alias + "`: " + cur + " -> " + best.id + " (" + note + "; " + why + ")"); claimed.add(best.id); continue; }
  if (repoint(alias, cur, best.id, note)) {
    aliases.set(alias, best.id);
    claimed.add(best.id);
    changes.push("repointed `" + alias + "`: " + cur + " -> " + best.id + " (" + note + "; " + why + ")");
  }
}

if (!DRY) {
  if (changes.length) {
    appendChangelog([...changes, SNAPPED
      ? "snapshot: " + path.basename(SNAPPED) + " (free-grow --revert restores it)"
      : "no file was modified, so no snapshot was needed"]);
  }
  saveLedger(ledger);
  fs.writeFileSync(STAMP, new Date().toISOString());

  // Publish to the dashboard's Delegation tab. Best-effort: a failed upload
  // must never fail a probe run whose ledger and routing are already saved.
  try {
    const ex = await import("./delegation-export.mjs");
    const { file } = await ex.exportStatus();
    const up = ex.upload(file);
    log("[free-grow] dashboard: " + (up.ok ? up.message : "upload failed - " + up.message));
  } catch (e) {
    log("[free-grow] dashboard export skipped: " + String(e?.message ?? e));
  }
}

log("");
if (changes.length) { log("[free-grow] " + changes.length + " change(s):"); for (const c of changes) log("  - " + c); }
else log("[free-grow] nothing worth changing — the current routing is still the best measured.");
log("[free-grow] ledger: " + Object.keys(ledger.models).length + " models measured | Anthropic tokens billed: 0");
log("");
