#!/usr/bin/env node
// delegation-export — publish the free-model roster to the dashboard.
//
//   free-sync            export the current state and upload it
//   (free-grow calls exportStatus() + upload() after every probe run)
//
// The dashboard runs on Vercel and cannot see this laptop: the gateway, the
// probe ledger and the call receipts all live here. So the state is written
// to ~/.omniroute/delegation-status.json, and the dashboard repo's own
// scripts/sync-delegation.mjs uploads it into mdb.settings under its own
// DB_URL. This file never touches a database credential.
//
// Zero Anthropic tokens: local files plus the local gateway.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BASE = "http://127.0.0.1:20128";
const HOME = os.homedir();
const ENV = path.join(HOME, ".omniroute", ".env");
const LOGS = path.join(HOME, ".omniroute", "call_logs");
const LEDGER = path.join(HOME, ".omniroute", "probe-ledger.json");
const STAMP = path.join(HOME, ".omniroute", ".last-grow");
const SAVINGS = path.join(HOME, ".omniroute", "savings.jsonl");
const ASKFREE = path.join(HOME, ".claude", "bin", "lib", "ask-free.mjs");
const QUEUE = path.join(HOME, ".claude", "optimize", "signup-queue.md");
const OUT = path.join(HOME, ".omniroute", "delegation-status.json");
// Optional: a dashboard repo with scripts/sync-delegation.mjs. Unset = export only.
const DASHBOARD = process.env.DELEGATION_DASHBOARD ?? "";

// Same filters free-grow uses, so the tab lists exactly what could be routed to.
const SKIP_MODEL = /embed|whisper|tts|speech|audio|image|vision|rerank|guard|moderat|bge|clip|sdxl|flux|stable-|diffusion|ocr|translate|transcri|fim|-base$/i;
const FLOOR = 3;

const envVal = (name) => {
  try {
    const m = fs.readFileSync(ENV, "utf8").match(new RegExp("^" + name + "=(.+)$", "m"));
    return m ? m[1].trim() : null;
  } catch { return null; }
};
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return dflt; } };

/**
 * One word per model, from the error text the gateway or provider returned.
 * The words are what the tab shows, so they have to mean something to a
 * person: "exhausted" = free allowance used up, "gone" = model retired,
 * "rate-limited" = asked too fast, try later.
 */
function classify(v) {
  if (!v) return "untested";
  if (v.ok) return (v.score ?? 0) >= FLOOR ? "working" : "weak";
  const e = String(v.err ?? "");
  if (/measured \d+% over/.test(e)) return "failing";
  if (/\b(401|402)\b|credit|exhaust|payment|entitle/i.test(e)) return "exhausted";
  if (/\b429\b|rate.?limit|too many|per minute/i.test(e)) return "rate-limited";
  if (/\b(404|410)\b|not found|gone|unavailable|end of life|no longer/i.test(e)) return "gone";
  if (/timeout|aborted/i.test(e)) return "timeout";
  return "error";
}

function providerStatus(connected, models) {
  if (!connected) return "off";
  const probed = models.filter((m) => m.status !== "untested");
  if (models.some((m) => m.status === "working")) return "working";
  if (!probed.length) return "untested";
  if (probed.every((m) => m.status === "exhausted")) return "exhausted";
  if (probed.every((m) => m.status === "gone")) return "stale";
  return "degraded";
}

async function gateway(p) {
  const tok = envVal("OMNIROUTE_DELEGATE_TOKEN");
  const r = await fetch(BASE + p, { headers: { Authorization: "Bearer " + tok }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(p + " -> HTTP " + r.status);
  return r.json();
}

export async function exportStatus() {
  const ledger = readJson(LEDGER, { models: {} }).models ?? {};

  // Which alias points where, read the same way free-grow reads it.
  const src = fs.readFileSync(ASKFREE, "utf8");
  const aliasOf = new Map();
  const aliases = [];
  for (const m of src.matchAll(/^\s{2}(\w+):\s+"([^"]+)"/gm)) {
    aliases.push({ alias: m[1], model: m[2] });
    aliasOf.set(m[2], [...(aliasOf.get(m[2]) ?? []), m[1]]);
  }

  // Real-traffic call counts per model, from the gateway's own logs.
  const calls = new Map();
  if (fs.existsSync(LOGS)) {
    for (const day of fs.readdirSync(LOGS)) {
      const dir = path.join(LOGS, day);
      let st; try { st = fs.statSync(dir); } catch { continue; }
      if (!st.isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        let s; try { s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).summary; } catch { continue; }
        if (!s) continue;
        const model = s.model ?? s.requestedModel ?? "?";
        if (model === "model-sync" || model === "connection-test") continue;
        const key = (s.provider ?? "?") + "/" + model;
        const e = calls.get(key) ?? { n: 0, ok: 0 };
        e.n++; if (s.status === 200) e.ok++;
        calls.set(key, e);
      }
    }
  }

  // Providers and their catalogues, straight from the gateway.
  let conns = [];
  let gatewayUp = true;
  try { conns = (await gateway("/api/providers")).connections ?? []; }
  catch { gatewayUp = false; }

  const providers = [];
  for (const c of conns) {
    let catalogue = [];
    if (c.isActive) {
      try { catalogue = ((await gateway("/api/providers/" + c.id + "/models")).models ?? []).map((m) => m.id); }
      catch { /* shown as an empty catalogue */ }
    }
    const usable = catalogue.filter((id) =>
      !SKIP_MODEL.test(id) && (c.provider !== "openrouter" || /:free$/.test(id)));
    // Models that were measured but have since left the catalogue still count:
    // "it used to answer and now it is gone" is exactly what the tab is for.
    const measured = Object.keys(ledger).filter((k) => k.startsWith(c.provider + "/")).map((k) => k.slice(c.provider.length + 1)).filter((id) => !SKIP_MODEL.test(id));
    const ids = [...new Set([...usable, ...measured])];

    const models = ids.map((id) => {
      const full = c.provider + "/" + id;
      const v = ledger[full];
      const t = calls.get(full);
      return {
        id,
        status: classify(v),
        score: v?.score ?? null,
        max: v?.max ?? null,
        ms: v?.ms ?? null,
        checked: v?.ts ?? null,
        reason: v && !v.ok ? String(v.err ?? "").slice(0, 140) : null,
        aliases: aliasOf.get(full) ?? [],
        calls: t ? { n: t.n, ok: t.ok } : null,
      };
    });
    const order = { working: 0, weak: 1, "rate-limited": 2, timeout: 3, failing: 4, error: 5, exhausted: 6, gone: 7, untested: 8 };
    models.sort((a, b) => (order[a.status] - order[b.status]) || ((b.score ?? -1) - (a.score ?? -1)) || ((a.ms ?? 1e9) - (b.ms ?? 1e9)) || a.id.localeCompare(b.id));

    providers.push({
      name: c.provider,
      connected: Boolean(c.isActive),
      status: providerStatus(Boolean(c.isActive), models),
      catalogue: catalogue.length,
      counts: models.reduce((acc, m) => ((acc[m.status] = (acc[m.status] ?? 0) + 1), acc), {}),
      models,
    });
  }
  const rank = { working: 0, degraded: 1, untested: 2, exhausted: 3, stale: 4, off: 5 };
  providers.sort((a, b) => (rank[a.status] - rank[b.status]) || a.name.localeCompare(b.name));

  // What delegation has done for Claude Code, from ask-free's receipts.
  const usage = { calls: 0, ok: 0, in: 0, out: 0, since: null };
  if (fs.existsSync(SAVINGS)) {
    for (const line of fs.readFileSync(SAVINGS, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      usage.calls++;
      usage.since ??= e.ts ?? null;
      if (e.ok) { usage.ok++; usage.in += e.in ?? 0; usage.out += e.out ?? 0; }
    }
  }

  let lastProbe = null;
  try { lastProbe = fs.statSync(STAMP).mtime.toISOString(); } catch { /* never probed */ }

  // Only the "Worth doing" section: the file also lists providers to skip,
  // and a skip is not something to put in front of the user as a to-do.
  const queueText = fs.existsSync(QUEUE) ? fs.readFileSync(QUEUE, "utf8") : "";
  const worth = queueText.split(/^## /m).find((sec) => sec.startsWith("Worth doing")) ?? "";
  const queue = [...worth.matchAll(/^- \*\*([^*]+)\*\*/gm)].map((m) => m[1]);

  const status = {
    version: 1,
    generated_at: new Date().toISOString(),
    gateway_up: gatewayUp,
    last_probe: lastProbe,
    next_probe: lastProbe ? new Date(Date.parse(lastProbe) + 7 * 864e5).toISOString() : null,
    providers,
    aliases: aliases.map((a) => {
      const v = ledger[a.model];
      return { ...a, status: classify(v), score: v?.score ?? null, ms: v?.ms ?? null };
    }),
    usage,
    queue,
  };
  fs.writeFileSync(OUT, JSON.stringify(status, null, 1));
  return { file: OUT, status };
}

/** Hand the file to the dashboard repo's uploader, which uses its own DB_URL. */
export function upload(file = OUT) {
  if (!DASHBOARD) return { ok: false, message: "no dashboard configured (set DELEGATION_DASHBOARD to enable upload)" };
  const script = path.join(DASHBOARD, "scripts", "sync-delegation.mjs");
  if (!fs.existsSync(script)) return { ok: false, message: "dashboard uploader not found at " + script };
  const r = spawnSync(process.execPath, [script, file], { cwd: DASHBOARD, encoding: "utf8", timeout: 60_000 });
  const out = ((r.stdout ?? "") + (r.stderr ?? "")).trim();
  return { ok: r.status === 0, message: out || "exit " + r.status };
}

// Run directly (free-sync): export, then upload.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { file, status } = await exportStatus();
  const working = status.providers.reduce((n, p) => n + (p.counts.working ?? 0), 0);
  console.log("exported " + status.providers.length + " providers, " + working + " working models -> " + file);
  if (!status.gateway_up) console.log("  gateway was not running: provider list is empty. Start it (any ask-free call) and rerun.");
  const up = upload(file);
  console.log((up.ok ? "uploaded: " : "upload FAILED: ") + up.message);
  process.exitCode = up.ok ? 0 : 1;
}
