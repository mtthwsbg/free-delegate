// free-stats -- what the free models have actually done for us.
//
// Reads ~/.omniroute/call_logs/**/*.json, which the gateway writes for every
// call. No model is invoked and nothing is fetched: this is arithmetic over
// local JSON, so it is free to run as often as you like.
//
//   free-stats            lifetime
//   free-stats 7          last 7 days only
//
// The success column is the point. Route by it -- see the rerouting rule in
// CLAUDE.md. A model below 80% belongs nowhere in CHAIN or a panel.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.join(os.homedir(), ".omniroute", "call_logs");
const days = Number(process.argv[2]) || 0;
const cutoff = days ? Date.now() - days * 864e5 : 0;

if (!fs.existsSync(ROOT)) {
  console.error("no call logs at " + ROOT + " -- has the gateway ever run?");
  process.exitCode = 1;
} else {

const stat = new Map();   // key -> {ok, n, tokens, durs[]}
let tin = 0, tout = 0, first = Infinity, last = 0;

for (const day of fs.readdirSync(ROOT)) {
  const dir = path.join(ROOT, day);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).summary; }
    catch { continue; }
    if (!s) continue;
    const t = Date.parse(s.timestamp ?? "");
    if (cutoff && !(t >= cutoff)) continue;
    if (t) { first = Math.min(first, t); last = Math.max(last, t); }

    const model = s.model ?? s.requestedModel ?? "?";
    // model-sync is the gateway refreshing a provider's catalogue, not inference.
    // Counting it inflates both call count and success rate.
    if (model === "model-sync") continue;
    const key = (s.provider ?? "?") + "/" + model;
    const e = stat.get(key) ?? { ok: 0, n: 0, tokens: 0, durs: [] };
    e.n++;
    if (s.status === 200) {
      e.ok++;
      const tk = s.tokens ?? {};
      const i = tk.in ?? 0, o = tk.out ?? 0;
      e.tokens += i + o; tin += i; tout += o;
      e.durs.push(s.duration ?? 0);
    }
    stat.set(key, e);
  }
}

const rows = [...stat.entries()].sort((a, b) => b[1].tokens - a[1].tokens || b[1].n - a[1].n);
const N = rows.reduce((a, [, e]) => a + e.n, 0);
const OK = rows.reduce((a, [, e]) => a + e.ok, 0);
const med = (d) => d.length ? [...d].sort((x, y) => x - y)[d.length >> 1] : 0;
const num = (x) => x.toLocaleString("en-US");
const span = (first < Infinity)
  ? new Date(first).toISOString().slice(0, 10) + " to " + new Date(last).toISOString().slice(0, 10)
  : "no calls";

console.log("");
console.log("Free-model usage" + (days ? " (last " + days + " days)" : " (lifetime)") + " -- " + span);
console.log("");
console.log("  calls        " + num(N) + "   ok " + num(OK) +
            "   failed " + num(N - OK) +
            (N ? "   success " + Math.round(100 * OK / N) + "%" : ""));
console.log("  tokens       in " + num(tin) + "   out " + num(tout) +
            "   total " + num(tin + tout));
console.log("  Anthropic tokens these calls cost: 0");
console.log("");
console.log("  " + "model".padEnd(50) + "calls".padStart(6) + "  ok%".padStart(5) +
            "median".padStart(8) + "tokens".padStart(10));
console.log("  " + "-".repeat(79));
// One-shot probes crowd out the models actually in rotation. Show what carries
// traffic; count the rest.
const MIN = 2;
const shown = rows.filter(([, e]) => e.n >= MIN || e.tokens > 0);
const hidden = rows.length - shown.length;
for (const [k, e] of shown) {
  const pct = Math.round(100 * e.ok / e.n);
  // a flag you can act on without reading the number twice
  const mark = e.n >= 3 && pct < 80 ? " <" : "";
  console.log("  " + (k.slice(0, 49)).padEnd(50) +
              String(e.n).padStart(6) +
              (pct + "%").padStart(5) +
              (med(e.durs) + "ms").padStart(8) +
              num(e.tokens).padStart(10) + mark);
}
console.log("");
if (hidden) console.log("  (" + hidden + " one-off probes not shown)");
console.log("  '<' = below 80% over 3+ calls. Reroute it (see CLAUDE.md) or drop it.");
console.log("");

// ---- ask-free's own receipts -------------------------------------------------
// The gateway log above counts every call THROUGH the gateway, including probes
// and panel members. savings.jsonl is narrower and answers a different question:
// what did delegation from Claude Code actually move off the paid path. Written
// by ask-free, one JSON line per call; absent until the first call after this
// was added, which is why nothing here assumes it exists.
const SAV = path.join(os.homedir(), ".omniroute", "savings.jsonl");
if (fs.existsSync(SAV)) {
  let n = 0, ok = 0, sin = 0, sout = 0, ms = 0;
  for (const line of fs.readFileSync(SAV, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const t = Date.parse(e.ts ?? "");
    if (cutoff && !(t >= cutoff)) continue;
    n++; if (e.ok) { ok++; sout += e.out ?? 0; sin += e.in ?? 0; ms += e.ms ?? 0; }
  }
  if (n) {
    console.log("  delegated from Claude Code: " + num(n) + " calls, " + num(ok) + " answered, " +
                "median " + Math.round(ms / Math.max(ok, 1)) + "ms");
    console.log("  " + num(sout) + " tokens of output Claude did not have to generate " +
                "(in " + num(sin) + ").");
    console.log("  That is the measured floor of the saving, not an estimate: it excludes");
    console.log("  the re-reads avoided by -o/--summarize, which are the larger half.");
    console.log("");
  }
}
}
