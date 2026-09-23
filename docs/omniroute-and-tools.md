# OmniRoute / ask-free — full reference

Moved out of CLAUDE.md 2026-08-31 to cut per-session token cost.
Read this file when delegation misbehaves, when picking a panel, or when adding a provider.

### Run several free models AT ONCE — the preferred mode

`ask-free --panel <name> -o FILE` sends one prompt to several models concurrently and
writes each answer to its own file. N answers cost roughly the wall-clock of the
SLOWEST one, not the sum: the `fast` panel returns three in ~2.3s. Panels:

| Panel | Members | Use for |
|---|---|---|
| `fast` | gpt-oss-120b, GLM-5.3-Flash, Nemotron-120B | default; ~2.3s for 3 answers |
| `broad` | + DeepSeek-V4, Kimi-K3 | 5 views when the answer is contested |
| `code` | codestral, DeepSeek, GLM, gpt-oss | code, where families disagree usefully |
| `max` | Nemotron-550B, Nemotron-120B, Kimi, DeepSeek, GLM-5.3 | hardest asks; ~21s |

Members are deliberately from DIFFERENT model families. Three checkpoints of one base
model agree with each other and teach you nothing.

**Judge a panel mechanically before reading anything.** Count the lines, run the test,
check the constraint, diff them against each other — then read only the survivor. A
panel that is read in full costs more than it saved. Use a panel when the answer is
contested, quality matters more than latency, or a constraint makes "best of N"
meaningfully better than "first of 1"; a single `-m bulk` call is right for routine
bulk work.

### The roster — all free, all measured, all verified answering

Sub-second: `bulk` gpt-oss-120b 0.66s · `code` codestral 0.59s · `fast` gpt-oss-20b
0.70s · `glm` GLM-5.3-Flash 0.70s · `big` Nemotron-3-super-120B 0.88s.
1-3s: `reason` GLM-5.3 1.5s · `gemma` Gemma-4-31B 1.5s · `deepseek` DeepSeek-V4-Flash
1.7s · `minimax` MiniMax-M3 1.7s · `kimi` Kimi-K3 1.8s · `qwen` Qwen3.8-flash 2.8s.
Heavy: `ultra` Nemotron-3-ultra-550B 21s · `quality` gemini-3.6-flash 6-14s.

`ask-free --list` prints the live catalog. Five providers are connected — groq,
gemini, mistral, huggingface, openrouter — and between them expose 640+ models, so if
an alias dies there is almost always a replacement one probe away.

**Standing permission: find and add more.** Probe candidates in parallel,
keep what answers, add it to ALIASES with its measured time, and use it. If a new
provider needs a signup, open a Chrome tab and ask the user to do that one step.

**Do not delegate when delegation costs more than it saves.** Delegation has real
overhead: the prompt you write, the result you read, the judging. For a one-line
edit, a quick factual answer, a rename, a small fix, a config tweak — that overhead
exceeds the work. Just do it, or give it to a haiku subagent. **Rough line: if you'd
write less than ~30 lines, write it yourself.** Delegation is for volume.

**Never read a large delegated artifact directly.** Use `ask-free -o <file>` so the
output lands on disk and never enters your context, then review it targeted: run the
tests, read the one function that matters, diff it, or have a haiku subagent read the
whole file and report back in three lines. Reading a 500-line file back costs ~7k of
your tokens; a targeted review costs a few hundred. This is the single biggest
lever in the whole setup — the generation was never the expensive part.


### How to delegate to a free model

Use the `ask-free` command. It is on the PATH and handles the token, provider
fallback, `<think>`-block stripping, and starting the gateway if it somehow isn't up.

```
ask-free "task text"                    # auto-picks the best live free provider
ask-free -m gemini "task text"          # force a provider
ask-free -f prompt.txt "extra context"  # long prompt from a file
ask-free -o out/draft.md "task text"    # result to disk, NOT into your context
ask-free -s "You are a terse editor." "task"
```

It prints a receipt to stderr — model, tokens in/out — so you can report the split.

**Hard-won settings — do not rediscover these:**

- `-m` takes an **alias** (`bulk`, `fast`, `quality`, `cheap`, `code`, `long`) or a
  full `provider/model` id. A BARE model name does not resolve — the gateway wants
  `gemini/gemini-3.6-flash`, not `gemini-3.6-flash`. `ask-free --list` prints the
  aliases and every live model per connection.
- **Verified working, 2026-08-29:** `bulk` (groq gpt-oss-120b, ~0.7s), `code`
  (mistral codestral-latest, ~0.6s), `quality` (gemini-3.6-flash, ~6-9s).
  Avoid `cheap` (gemini-flash-lite) — it answers in 2s or 76s with no pattern.
  `gemini-2.5-*` is RETIRED (404 "no longer available to new users"), and
  `gemini-3.7-flash` and `gemini-3.5-flash-lite` both hang past 60s.
- Set `--max` generously (3000+ for a file review). These are reasoning models —
  gemini-flash-lite spent 88 reasoning tokens answering "Say OK" — so a small budget
  is consumed entirely by thinking and returns empty. The helper reports
  `reasoning_tokens` when that happens.
- The gateway's `requestQueue.maxWaitMs` was raised from 15s to 180s via
  `PATCH /api/resilience`. At 15s every real file review timed out. If delegation
  starts returning `RATE_LIMIT_EXECUTION_TIMEOUT`, that setting was reset.

**Why this was dead for a whole session, so it is not misdiagnosed again:**

- `/v1/*` needs a provisioned **API key**, NOT `OMNIROUTE_DELEGATE_TOKEN` (that is an
  admin access token, good only for `/api/*`). The gateway shipped with **zero** keys,
  so every completion failed at auth and surfaced as `504 DIRECT_RESPONSE_START_TIMEOUT`
  — an error that points at the providers and hides the real cause. `ask-free` now
  mints a key automatically if `OMNIROUTE_API_KEY` is missing, so this cannot recur.
- `ask-free` was a `.cmd` shim only, which **Git Bash cannot see** — so it was
  unusable from the shell most tool calls run in. There is now an extensionless
  `sh` wrapper beside it.

A `SessionStart` hook warms the gateway in the background at launch (0.3s, does not
block the terminal), so `ask-free` is normally instant. A `SessionEnd` hook kills the
gateway and the claude-mem worker when the session ends. `omni-stop` frees the memory
mid-session. You never manage the gateway by hand.

There is deliberately **no `omniroute` MCP server** — it died at session start
whenever the gateway wasn't already up. Do not re-add it.

**Always fact-check what comes back.** Free models confidently invent specifics.
A verified case: asked for resume bullets with no numbers supplied, gpt-oss-120b
returned "slashing cycle time by 45%" and "reducing operator intervention by
30%" — both fabricated. Strip or flag every number, date, name, and claim a free
model produces that wasn't in the prompt.


## free-grow — the roster maintains itself (added 2026-09-18)

`free-scout` reports unused capacity and waits for a human, which is why 500+
catalogued models had never been called. `free-grow` acts instead.

```
free-grow --probe              discover untried models, score them, repoint aliases
free-grow --probe --dry-run    print the promotions it would make, change nothing
free-grow --report             the measured ledger, probes nothing
free-grow --acquire            wire up providers whose credential we already hold
free-grow --revert             restore ask-free.mjs from the last snapshot
```

It scores **mechanically** — a fixed 6-question set with exact-match answers, no
model judging another model — and writes `~/.omniroute/probe-ledger.json`, which
`ask-free` now reads at call time: `CHAIN` is an ordering derived from measured
score and latency, not the hardcoded list. A model measured as down leaves
rotation and is skipped in panels without anyone noticing it first.

Rules it enforces, each of which exists because the first version got it wrong:

- **A quality floor.** A rescue may not install a model below 3/6 however dead
  the incumbent is — the first run put a 1/6 model on `reason` purely because the
  holder was 401ing.
- **One alias per model.** Without it the single best scorer swept six aliases
  and the "different families" property of every panel quietly disappeared.
- **Family-named aliases are a contract.** `cohere`, `llama`, `glm`, `gemma`,
  `deepseek`, `kimi`, `qwen`, `minimax` may only be taken over by that family.
  `bulk`/`fast`/`big`/`reason` name a job and are open. `code`, `quality` and
  `ultra` are never auto-promoted: they are chosen for a KIND of work, and
  arithmetic scores say nothing about that.
- **Snapshot before the first byte changes**, to `~/.claude/optimize/applied/`,
  and `--revert` only accepts files matching its own timestamped naming.

A SessionStart hook (`grow-weekly.ps1`, called from `gateway-warm.ps1`) runs a
probe at most once every 7 days, detached, with a 5-minute wall-clock deadline.
`session-cleanup.ps1` kills a probe still running at session end.

**Signups are a queue, not an automation.** Creating a provider account requires
your email and a ToS acceptance, so `--acquire` wires up only what already has a
credential and writes the rest to `~/.claude/optimize/signup-queue.md`.

### Two additions to ask-free

- `--summarize N` — after `-o FILE`, a SECOND free model compresses the artifact
  to N lines and only those return. This closes the last hole: the artifact was
  generated free and then read back at full price.
- Every call appends a receipt to `~/.omniroute/savings.jsonl`, and `free-stats`
  totals it, so the delegation ledger is measured rather than estimated.

## free-delegate — delegation in claude.ai chat and Cowork (added 2026-09-18)

The repo root deploys as a Vercel project. One MCP server with three tools: `delegate` (returns
~40 lines plus a ref, the chat equivalent of `ask-free -o`), `delegate_fetch`,
`delegate_list`. Auth is the secret path segment `/api/mcp/<MCP_SECRET>`.

`lib/aliases.json` is GENERATED from `ask-free.mjs` by `scripts/sync-aliases.mjs`
— re-run and push it after a `free-grow` run that changed routing, or the hosted
copy will route chat to models measured as dead.

The rules that make Claude actually use it live in
`docs/claude-chat-preferences.md` (paste into claude.ai personal
preferences). Chat has no CLAUDE.md, so without that block the connector is dead
weight.

**Limit worth remembering:** a tool result always enters the chat context, so the
saving there is real but smaller than in Claude Code, where `-o FILE` keeps the
output out entirely.


## Installing third-party code

Scan it first: `skillspector scan <path> --no-llm` (installed via uv, CLI only).

Read the **findings**, not the score. The score measures how much damage the code
*could* do, not whether it intends to — Anthropic's own `claude-code-setup` plugin
scores 100/100 CRITICAL, and `ponytail`'s flags include its own security test
asserting that `;rm -rf` gets rejected. Docs, tests, and `.env.example` files
generate constant false positives.

What actually matters in the output: destructive commands presented as patterns to
follow, network calls to unexpected hosts, credential reads, and instructions aimed
at overriding your own behavior. Judge those on their merits and tell the user what
you found before installing.

