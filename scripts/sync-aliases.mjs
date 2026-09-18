// Generate lib/aliases.json from the local ask-free routing table.
//
// The bridge must not carry a second hand-maintained roster: free-grow rewrites
// ask-free's ALIASES automatically, and a copy that nobody updates would quietly
// route chat to models the local setup has already measured as dead. So there is
// exactly one source of truth and this copies from it.
//
//   node scripts/sync-aliases.mjs     then commit and push
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SRC = path.join(os.homedir(), ".claude", "bin", "lib", "ask-free.mjs");
const OUT = path.join(process.cwd(), "lib", "aliases.json");

const src = fs.readFileSync(SRC, "utf8");

const aliases = {};
for (const m of src.matchAll(/^\s{2}(\w+):\s+"([^"]+)"/gm)) aliases[m[1]] = m[2];
if (!Object.keys(aliases).length) {
  console.error("no aliases parsed from " + SRC + " — refusing to write an empty roster");
  process.exit(1);
}

// CHAIN is written as ALIASES.x references, so resolve the names rather than
// trying to read model ids that are not literally there.
const chainSrc = src.match(/const CHAIN = \[([^\]]+)\]/)?.[1] ?? "";
const chain = chainSrc.split(",")
  .map(s => s.trim().replace(/^ALIASES\./, ""))
  .filter(Boolean)
  .map(name => aliases[name])
  .filter(Boolean);

fs.writeFileSync(OUT, JSON.stringify({
  synced: new Date().toISOString().slice(0, 10),
  source: "ask-free.mjs",
  aliases,
  chain: chain.length ? chain : Object.values(aliases).slice(0, 4),
}, null, 2) + "\n");

console.log("wrote " + OUT + " — " + Object.keys(aliases).length + " aliases, chain of " + chain.length);
