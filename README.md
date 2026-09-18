# free-delegate

An MCP bridge that lets **claude.ai chat and Cowork** hand bulk work to free
models, the way `ask-free` already does inside Claude Code.

Chat and Cowork have no shell, so the local gateway on the laptop cannot reach
them: every draft, rewrite and summary there is produced by Claude itself and
comes out of a fixed quota. This is one small Vercel function exposing three
tools over MCP, added once as a custom connector.

## What it gives Claude

| Tool | What it does |
|---|---|
| `delegate` | Runs a task on a free model. Returns ~40 lines plus a `ref` by default, so a long result does not fill the conversation. |
| `delegate_fetch` | Returns a line range of a previous result, only if it is actually needed. |
| `delegate_list` | The alias roster and which provider keys this deployment has. |

## Setup

1. `vercel link` (or import the repo in the Vercel dashboard).
2. `powershell -File scripts/push-env.ps1` — sets `MCP_SECRET` and whatever
   provider keys you want. One key is enough to start.
3. `vercel --prod`.
4. claude.ai → Settings → Connectors → Add custom connector, URL:
   `https://<deployment>/api/mcp/<MCP_SECRET>`
5. Paste `reference/claude-chat-preferences.md` into Settings → Personal
   preferences, so Claude actually reaches for the tool.

## The routing table is not maintained here

`lib/aliases.json` is **generated** from the local `ask-free.mjs`, which
`free-grow` rewrites automatically as models are measured. After a `free-grow`
run that changed something:

```
node scripts/sync-aliases.mjs && git commit -am "sync roster" && git push
```

A second hand-kept roster would drift and route chat to models the local setup
has already measured as dead.

## Honest limits

- **Tool results always enter the chat context.** In Claude Code, `ask-free -o`
  keeps output out entirely; here `head` + `ref` recovers most of that, but the
  saving is real and smaller.
- **`delegate_fetch` is best-effort.** Results are held in the function
  instance's memory, so a `ref` survives while the instance is warm and not
  reliably longer. When it is gone the tool says so and asks for a re-run
  instead of inventing an answer.
- **Only providers with a key here work.** The bridge cannot see the laptop's
  gateway; the keys are stored encrypted in that local database and have to be
  entered once on Vercel.
