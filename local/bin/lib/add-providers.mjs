#!/usr/bin/env node
/*
  add-providers — wire new free-tier providers into OmniRoute.

  Run it, paste each API key when asked, press Enter to skip one. It mints the
  admin token it needs, creates each connection, tests it, and prints what works.

  Keys are read from YOUR terminal and written straight to OmniRoute's local
  store. They never pass through Claude and never appear in the chat transcript,
  which is the whole reason this is a script you run rather than keys you paste
  into the chat.
*/

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";

const BASE = "http://127.0.0.1:20128";
const ENV = path.join(os.homedir(), ".omniroute", ".env");
const ENTRY = path.join(process.env.APPDATA ?? "", "npm", "node_modules", "omniroute", "bin", "omniroute.mjs");

// id = OmniRoute's provider id. Verified against its own catalog.
const PROVIDERS = [
  { id: "nvidia",        name: "NVIDIA NIM",          where: "build.nvidia.com -> any model -> 'Get API Key'",     free: "~40 req/min, 70+ models" },
  // VERIFIED DEAD 2026-09-03. Key authenticated fine (GET /v1/models = 200) but
  // every completion returns 402 payment_required, param "quota", with
  // x-should-retry:false -- an account-entitlement refusal, not an exhausted
  // daily allowance (that would be a 429 with ratelimit headers). The console
  // shows balance $0.00, 0 tokens ever used, and per-million pricing on every
  // model with only ADD CREDITS / EXPLORE PLANS. The "1M tokens/day free" line
  // below is how Cerebras used to onboard; it is not what this account gets.
  // Leave it listed -- if the free tier returns, the wiring is one key away.
  { id: "cerebras",      name: "Cerebras",            where: "cloud.cerebras.ai -> API Keys (tab is already open)", free: "WAS 1M tokens/DAY -- now pay-as-you-go, see note above" },
  { id: "cohere",        name: "Cohere",              where: "dashboard.cohere.com/api-keys -> use the Trial key",  free: "1,000 calls/month" },
  // VERIFIED DEAD 2026-09-03. Key authenticates; GET /user/balance returns
  // is_available:false with granted_balance "0.00" and total "0.00". DeepSeek is
  // prepaid-only now -- there is no free grant to activate, so completions 401.
  // Connected once and deactivated in the gateway so nothing routes to it.
  { id: "deepseek",      name: "DeepSeek",            where: "platform.deepseek.com/api_keys -> Create",            free: "NONE -- prepaid only, no signup grant" },
  { id: "scaleway",      name: "Scaleway",            where: "console.scaleway.com -> IAM -> API Keys",             free: "1M tokens, EU/GDPR" },
  { id: "cloudflare-ai", name: "Cloudflare Workers AI", where: "dash.cloudflare.com -> My Profile -> API Tokens",   free: "10K neurons/day" },
];

function envVal(name) {
  try {
    const m = fs.readFileSync(ENV, "utf8").match(new RegExp("^" + name + "=(.+)$", "m"));
    return m ? m[1].trim() : null;
  } catch { return null; }
}

// The admin token. `tokens create` needs admin, but the local CLI is trusted, so
// it can mint one for itself. Cached in .env so this only happens once.
function adminToken() {
  const cached = envVal("OMNIROUTE_ADMIN_TOKEN");
  if (cached) return cached;
  console.log("Minting an admin token (one time)...");
  const r = spawnSync(process.execPath,
    [ENTRY, "tokens", "create", "--name", "claude-code-provider-admin", "--scope", "admin", "--output", "json"],
    { encoding: "utf8", timeout: 90000 });
  const out = (r.stdout || "") + (r.stderr || "");
  const m = out.match(/oma_live_[A-Za-z0-9_-]+/);
  if (!m) {
    console.error("Could not mint an admin token. Raw output:\n" + out.slice(0, 600));
    process.exit(1);
  }
  fs.appendFileSync(ENV, "\nOMNIROUTE_ADMIN_TOKEN=" + m[0] + "\n");
  console.log("  admin token saved to ~/.omniroute/.env\n");
  return m[0];
}

async function api(tok, method, pathname, body) {
  const r = await fetch(BASE + pathname, {
    method,
    headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: r.ok, status: r.status, json, text };
}

const tok = adminToken();
const existing = (await api(tok, "GET", "/api/providers")).json?.connections ?? [];
const have = new Set(existing.filter(c => c.isActive).map(c => c.provider));
console.log("Already connected: " + [...have].join(", ") + "\n");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const results = [];

for (const p of PROVIDERS) {
  if (have.has(p.id)) { results.push([p.name, "skipped", "already connected"]); continue; }
  console.log(`\n--- ${p.name}  (${p.free})`);
  console.log(`    key from: ${p.where}`);
  const key = (await rl.question("    paste key (Enter to skip): ")).trim();
  if (!key) { results.push([p.name, "skipped", "no key given"]); continue; }

  const create = await api(tok, "POST", "/api/providers", {
    provider: p.id, authType: "apikey", apiKey: key, name: p.id, isActive: true,
  });
  if (!create.ok) {
    results.push([p.name, "FAILED", "create: " + create.text.slice(0, 90)]);
    continue;
  }
  const id = create.json?.id ?? create.json?.connection?.id;
  const test = await api(tok, "POST", `/api/providers/${id}/test`);
  const models = (await api(tok, "GET", `/api/providers/${id}/models`)).json?.models?.length ?? 0;
  results.push([p.name, test.ok ? "connected" : "created (test failed)", models + " models"]);
  console.log(`    -> ${test.ok ? "connected" : "created, test failed"}, ${models} models`);
}
rl.close();

console.log("\n" + "=".repeat(64));
for (const [n, s, d] of results) console.log(n.padEnd(26) + s.padEnd(24) + d);
console.log("=".repeat(64));
const now = (await api(tok, "GET", "/api/providers")).json?.connections?.filter(c => c.isActive) ?? [];
console.log(`\n${now.length} providers now active: ` + now.map(c => c.provider).sort().join(", "));
console.log("\nTell Claude it's done and it will probe the new models and add the fast ones to routing.");
