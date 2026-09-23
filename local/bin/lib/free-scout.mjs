// free-scout -- look for capability we are paying nothing for and not using.
//
// Joins the gateway's live model catalogue against the measured reliability in
// ~/.omniroute/call_logs, and reports three things worth acting on:
//
//   1. aliases and CHAIN members whose measured success has fallen below 80%
//   2. providers with an active account we have essentially never called
//   3. how many catalogued models have never been tried at all
//
// Free to run: it talks only to the local gateway and reads local JSON. No
// model is invoked. Run it when routing feels off, or every few weeks.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = "http://127.0.0.1:20128";
const ENV  = path.join(os.homedir(), ".omniroute", ".env");
const LOGS = path.join(os.homedir(), ".omniroute", "call_logs");
const THRESHOLD = 80;

const envVal = (name) => {
  try {
    const m = fs.readFileSync(ENV, "utf8").match(new RegExp("^" + name + "=(.+)$", "m"));
    return m ? m[1].trim() : null;
  } catch { return null; }
};

// ---- measured reliability, from the same logs free-stats reads ---------------
const stat = new Map();          // "provider/model" -> {ok, n}
const byProvider = new Map();    // provider -> {ok, n}
if (fs.existsSync(LOGS)) {
  for (const day of fs.readdirSync(LOGS)) {
    const dir = path.join(LOGS, day);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      let s;
      try { s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).summary; } catch { continue; }
      if (!s) continue;
      const model = s.model ?? s.requestedModel ?? "?";
      if (model === "model-sync") continue;      // catalogue refresh, not inference
      const good = s.status === 200;
      for (const [map, key] of [[stat, (s.provider ?? "?") + "/" + model], [byProvider, s.provider ?? "?"]]) {
        const e = map.get(key) ?? { ok: 0, n: 0 };
        e.n++; if (good) e.ok++;
        map.set(key, e);
      }
    }
  }
}
const pct = (e) => e && e.n ? Math.round(100 * e.ok / e.n) : null;

// ---- what ask-free currently routes to --------------------------------------
const src = fs.readFileSync(path.join(os.homedir(), ".claude", "bin", "lib", "ask-free.mjs"), "utf8");
const aliases = new Map();
for (const m of src.matchAll(/^\s{2}(\w+):\s+"([^"]+)"/gm)) aliases.set(m[1], m[2]);

// An alias only reachable by typing -m NAME is opt-in: a bad one costs nothing
// until someone asks for it. An alias inside CHAIN or a PANEL is in rotation and
// gets used without anyone choosing it -- that is the one worth flagging.
const rotation = new Set();
for (const block of [src.match(new RegExp("const CHAIN = \\[[^\\]]*\\]", "s"))?.[0] ?? "",
                     src.match(new RegExp("const PANELS = \\{[^;]*\\};", "s"))?.[0] ?? ""].join(" ").matchAll(new RegExp("ALIASES\\.(\\w+)", "g")))
  rotation.add(block[1]);

console.log("\n=== routing health " + "=".repeat(40));
let bad = 0;
for (const [name, id] of aliases) {
  const e = stat.get(id);
  const p = pct(e);
  if (p === null) { console.log("  " + name.padEnd(10) + "never called   " + id); continue; }
  const inUse = rotation.has(name);
  const flag = inUse && e.n >= 3 && p < THRESHOLD;
  if (flag) bad++;
  console.log("  " + (inUse ? "* " : "  ") + name.padEnd(10) +
              (p + "%").padStart(4) + " of " + String(e.n).padStart(3) +
              "   " + id + (flag ? "   <-- REROUTE (below " + THRESHOLD + "%)" : ""));
}
console.log(bad ? "\n  " + bad + " alias(es) need rerouting. Pick a replacement from `free-stats`."
                : "\n  No alias is below " + THRESHOLD + "% on 3+ calls.");

// ---- unused free capacity ----------------------------------------------------
const tok = envVal("OMNIROUTE_ADMIN_TOKEN");
if (!tok) {
  console.log("\n(no admin token in ~/.omniroute/.env -- skipping the catalogue scan;");
  console.log(" run `add-providers` once to mint one)\n");
} else {
  let conns = [];
  try {
    const r = await fetch(BASE + "/api/providers", {
      headers: { Authorization: "Bearer " + tok },
      signal: AbortSignal.timeout(15000),
    });
    conns = (await r.json())?.connections?.filter((c) => c.isActive) ?? [];
  } catch (e) {
    console.log("\ngateway not reachable at " + BASE + " -- " + e.message + "\n");
  }

  if (conns.length) {
    console.log("\n=== free capacity not being used " + "=".repeat(26));
    let untried = 0, models = 0;
    const idle = [];
    for (const c of conns) {
      let list = [];
      try {
        const r = await fetch(BASE + "/api/providers/" + c.id + "/models", {
          headers: { Authorization: "Bearer " + tok },
          signal: AbortSignal.timeout(20000),
        });
        list = (await r.json())?.models ?? [];
      } catch { /* a provider that will not list is a provider we cannot use */ }
      models += list.length;
      for (const m of list) {
        const id = typeof m === "string" ? m : (m.id ?? m.name ?? "");
        if (id && !stat.has(c.provider + "/" + id)) untried++;
      }
      const use = byProvider.get(c.provider);
      if (!use || use.ok === 0) idle.push(c.provider + " (" + list.length + " models, " +
        (use ? use.n + " calls, none succeeded" : "never called") + ")");
    }
    console.log("  " + conns.length + " active accounts, " + models + " catalogued models, " +
                untried + " never tried");
    if (idle.length) {
      console.log("\n  accounts producing nothing today:");
      for (const s of idle) console.log("    - " + s);
      console.log("\n  Worth one probe each. If a probe fails on billing or auth, record it");
      console.log("  in your notes so it is not re-investigated later.");
    }
  }
}
console.log("");
