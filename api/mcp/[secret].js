// The delegation bridge for claude.ai chat and Cowork.
//
// Those surfaces have no shell, so the local `ask-free` command cannot reach
// them and every bulk task there is done by Claude itself, out of a fixed quota.
// This exposes the same free-model roster as one MCP server, so the work moves
// off the paid path in chat exactly as it already does in Claude Code.
//
// Protocol: MCP over Streamable HTTP, POST only, plain JSON responses (no SSE
// stream is needed for tools this small). Auth is the secret path segment —
// /api/mcp/<MCP_SECRET> — checked before anything else happens.

import { complete, configured, splitId } from "../../lib/providers.js";
import ALIASES from "../../lib/aliases.json" with { type: "json" };

// Results the caller chose not to load. Module scope, so it survives between
// invocations on a WARM instance and nothing more: a serverless function is not
// a database and pretending otherwise is how you get silent data loss. Expiry is
// therefore honest rather than guaranteed, and delegate_fetch says so when a ref
// is gone instead of inventing an answer.
const CACHE = new Map();
const CACHE_MAX = 25;
function remember(text, model) {
  const ref = Math.random().toString(36).slice(2, 10);
  CACHE.set(ref, { text, model, at: Date.now() });
  while (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
  return ref;
}

const HEAD_LINES = 40;
const resolve = (name) => ALIASES.aliases[name] ?? name;

const TOOLS = [
  {
    name: "delegate",
    description:
      "Run a task on a FREE model instead of doing it yourself. Use for bulk or mechanical work: " +
      "drafts, boilerplate, rewrites, summaries, extraction, classification, first-pass code. " +
      "Returns the first lines plus a ref by default so a long result does not fill the conversation; " +
      "call delegate_fetch only if the rest is actually needed. Do not use it for judgement, " +
      "for deciding an approach, or for anything under ~30 lines, where the overhead costs more than it saves.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The full instruction for the free model, self-contained." },
        model: { type: "string", description: "Alias (bulk, fast, code, big, reason, quality, ultra) or a full provider/model id. Default: bulk." },
        system: { type: "string", description: "Optional system prompt." },
        max_tokens: { type: "number", description: "Default 2048. Raise for long output; reasoning models need room to think." },
        return_mode: { type: "string", enum: ["head", "full"], description: "head (default) returns ~40 lines plus a ref; full returns everything." },
      },
      required: ["task"],
    },
  },
  {
    name: "delegate_fetch",
    description: "Return more of a previous delegate result by its ref. Only the portion asked for is returned.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        from_line: { type: "number", description: "1-based. Default 1." },
        lines: { type: "number", description: "How many lines to return. Default 80." },
      },
      required: ["ref"],
    },
  },
  {
    name: "delegate_list",
    description: "List the aliases this bridge can route to and which providers are configured.",
    inputSchema: { type: "object", properties: {} },
  },
];

const ok = (text) => ({ content: [{ type: "text", text }] });
const fail = (text) => ({ content: [{ type: "text", text }], isError: true });

async function runTool(name, a = {}) {
  if (name === "delegate_list") {
    const live = configured();
    const lines = Object.entries(ALIASES.aliases).map(([k, v]) => {
      const [p] = splitId(v);
      return "  " + k.padEnd(9) + v + (live.includes(p) ? "" : "   [provider key not set here]");
    });
    return ok("aliases:\n" + lines.join("\n") +
      "\n\nproviders configured on this deployment: " + (live.join(", ") || "none") +
      "\nroster last synced from the local ask-free table: " + (ALIASES.synced ?? "unknown"));
  }

  if (name === "delegate_fetch") {
    const hit = CACHE.get(a.ref);
    if (!hit) return fail("ref '" + a.ref + "' is no longer held. This bridge keeps results only while the " +
      "instance stays warm, so re-run delegate with return_mode 'full' to get the whole answer.");
    const all = hit.text.split(/\r?\n/);
    const from = Math.max(1, a.from_line ?? 1);
    const take = Math.max(1, a.lines ?? 80);
    const slice = all.slice(from - 1, from - 1 + take);
    return ok(slice.join("\n") + "\n\n[lines " + from + "-" + (from - 1 + slice.length) +
      " of " + all.length + " from " + hit.model + "]");
  }

  if (name !== "delegate") return fail("unknown tool: " + name);
  if (!a.task || !String(a.task).trim()) return fail("delegate needs a task.");

  const wanted = resolve(a.model ?? "bulk");
  const messages = [];
  if (a.system) messages.push({ role: "system", content: String(a.system) });
  messages.push({ role: "user", content: String(a.task) });

  // Try the requested model, then the chain, skipping providers this deployment
  // has no key for. Two failures is the budget: walking the whole roster on a bad
  // day burns the caller's time for a result that was never coming.
  const live = configured();
  const order = [wanted, ...ALIASES.chain.filter(id => id !== wanted)]
    .filter(id => live.includes(splitId(id)[0]));
  if (!order.length) {
    return fail("No usable provider. Requested '" + wanted + "'; keys present for: " +
      (live.join(", ") || "none") + ". Add the provider key to this deployment's environment variables.");
  }

  const tried = [];
  let out = null;
  for (const id of order) {
    const r = await complete(id, messages, a.max_tokens ?? 2048);
    if (r.text) { out = r; break; }
    tried.push(id + " -> " + r.err);
    if (tried.length >= 2) break;
  }
  if (!out) return fail("Every free model tried failed:\n" + tried.join("\n"));

  const u = out.usage ?? {};
  const receipt = "\n\n[" + out.model + " | in " + (u.prompt_tokens ?? "?") +
                  " | out " + (u.completion_tokens ?? "?") + " | this ran on a free model]";

  if ((a.return_mode ?? "head") === "full") return ok(out.text + receipt);

  const all = out.text.split(/\r?\n/);
  if (all.length <= HEAD_LINES) return ok(out.text + receipt);
  const ref = remember(out.text, out.model);
  return ok(all.slice(0, HEAD_LINES).join("\n") +
    "\n\n[" + (all.length - HEAD_LINES) + " more lines held as ref '" + ref +
    "' — call delegate_fetch only if you need them]" + receipt);
}

export default async function handler(req, res) {
  if (req.query.secret !== process.env.MCP_SECRET || !process.env.MCP_SECRET) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (req.method !== "POST") {
    // No SSE endpoint: a client that cannot POST JSON-RPC has nothing to talk to
    // here, and saying so plainly beats holding a stream open that never speaks.
    res.status(405).json({ error: "POST JSON-RPC only" });
    return;
  }

  const msg = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const reply = (result) => res.status(200).json({ jsonrpc: "2.0", id: msg.id, result });

  try {
    switch (msg.method) {
      case "initialize":
        return reply({
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "free-delegate", version: "1.0.0" },
        });
      case "notifications/initialized":
        return res.status(202).end();
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call":
        return reply(await runTool(msg.params?.name, msg.params?.arguments));
      default:
        return res.status(200).json({
          jsonrpc: "2.0", id: msg.id,
          error: { code: -32601, message: "method not found: " + msg.method },
        });
    }
  } catch (e) {
    return res.status(200).json({
      jsonrpc: "2.0", id: msg?.id ?? null,
      error: { code: -32603, message: String(e.message ?? e).slice(0, 300) },
    });
  }
}
