# The delegation protocol

Paste this into your global `~/.claude/CLAUDE.md`. It is the rule set that makes
Claude Code hand bulk work to free models instead of spending your quota on it.
The tools it names are in `local/bin/`.

## Delegation — free models do the work, you check it

This is **delegation**, and it should be applied aggressively, including
finding *new* surfaces for it. `ask-free` is on the PATH and handles tokens,
provider fallback, and gateway startup.

```
ask-free "task"                 # auto-pick a live free provider
ask-free -m bulk "task"         # force one: bulk|code|quality|glm|big|reason
ask-free -f prompt.txt "extra"  # long prompt from a file
ask-free -o out.md "task"       # result to disk, NOT into context
ask-free --panel fast -o out.md # several models at once, cost of the slowest
free-stats                      # what the free models have done: reliability + lifetime tokens
free-scout                      # unused free capacity, and aliases that have gone bad
```

| Work | Engine |
|---|---|
| Counting, diffing, parsing, searching | **a program** — grep/sed/python. Cheapest of all; no model. |
| Drafts, boilerplate, bulk rewrites, summaries | `ask-free -m bulk` (cohere, 0.7s, 100%) or `-m quality` (nemotron 120B, 1.9s) |
| Code where quality matters | `ask-free -m code` |
| Reading a big file to answer one question | free model with `-f`, not `Read` |
| Audio or video → text | `hear <file-or-folder>` — Groq Whisper, free, writes `.txt` beside each |
| Screenshot / slide / photo → text | `see <file-or-folder> -o FILE` — free vision; 12 slides = ~1.6k tokens vs ~184k reading them |
| Codebase search, diff review, browsing | Anthropic subagent — **paid**, label it |
| Deciding, judging, integrating, talking to the user | **you (Claude)** |

Rules that make it actually save:

- **Don't delegate below ~30 lines** — the prompt plus the review costs more.
- **Always verify what comes back**, hardest on the claims the task is *about*.
  Free models invent specifics: strip or flag every number, date, and name
  that wasn't in the prompt.
- **Don't delegate the decision itself** — approach, tradeoffs, and quality
  judgement stay with you.
- **More Anthropic subagents is not delegation.** Multi-agent setups use ~15×
  the tokens and count against the same limit. Free models save; extra Claude
  agents cost.

**Route by measured reliability, not by reputation.** `~/.omniroute/call_logs/`
records every call. Before blaming the gateway, run `free-stats` — three
"gateway is dead" sessions were a misrouted alias, not a dead gateway. If a
CHAIN or panel member falls below 80% over 3+ calls, repoint it from the
`free-stats` table and say so in the ledger; that is tuning, not a change that
needs asking. `ask-free` stops after 2 provider failures and tells you which.

Full provider roster, panels, and troubleshooting:
`docs/omniroute-and-tools.md` (install it at `~/.claude/reference/`). There is deliberately no
`omniroute` MCP server; do not re-add one. Never leave the gateway running
after a session ends.

### Token ledger — REQUIRED on every reply that delegated

End with a **markdown table**: model, free or paid, tokens they produced,
tokens it cost here, approx saved. `ask-free` prints the counts on stderr.
If nothing was delegated and you spent over ~500 tokens, give a one-line
Anthropic-only summary instead. Under ~500 tokens, say nothing. Never claim a
saving for a call that failed.

