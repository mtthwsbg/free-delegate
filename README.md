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

Already done: the project exists, is linked to this repo, and is deployed to
`https://free-delegate-mtthwsbg.vercel.app`.

1. **Turn off Vercel Authentication.** Vercel → free-delegate → Settings →
   Deployment Protection → Vercel Authentication → Disabled → Save.
   It defaults to on, and while it is on every request gets an SSO redirect, so
   claude.ai cannot reach the endpoint at all. After this the only thing guarding
   it is `MCP_SECRET` in the URL, which is the trade this design makes.
2. `powershell -File scripts/push-env.ps1` — sets `MCP_SECRET` and whatever
   provider keys you want. One key is enough to start.
3. `vercel deploy --prod --yes` so the new variables are picked up.
   (Pass `< /dev/null` if you script it: the CLI ignores `--yes` and waits on
   stdin when stdin is a live terminal it cannot read.)
4. claude.ai → Settings → Connectors → Add custom connector, URL:
   `https://free-delegate-mtthwsbg.vercel.app/api/mcp/<MCP_SECRET>`
5. Paste `~/.claude/reference/claude-chat-preferences.md` into Settings →
   Personal preferences, so Claude actually reaches for the tool.

Check it from a terminal at any point — a wrong secret must 401, the right one
must list three tools:

```
curl -s -X POST https://free-delegate-mtthwsbg.vercel.app/api/mcp/<MCP_SECRET>   -H "Content-Type: application/json"   -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

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
