# free-delegate

A delegation protocol that lets Claude Code (and claude.ai chat / Cowork) hand drafts, rewrites, summaries, transcription, and image-to-text to free models. Claude decides what to hand off and checks what comes back; the free models do the heavy lifting, and your Claude quota goes to judgement instead of bulk text.

## What’s in here

| Path | Description |
|------|-------------|
| `docs/PROTOCOL.md` | Rules to paste into `~/.claude/CLAUDE.md` (when to delegate, when not, verification steps, token ledger). |
| `local/bin/` | Claude Code toolkit: command-line shims (`.cmd`) for cmd/PowerShell and POSIX wrappers for Git Bash. |
| `local/hooks.settings.json` | Three Claude Code hooks: **SessionStart** warms the gateway, **UserPromptSubmit** adds a one-line routing reminder, **SessionEnd** kills the gateway so nothing runs in the background. |
| `docs/omniroute-and-tools.md` | Full reference: provider roster, aliases, panels, troubleshooting. |
| `docs/signup-queue.md` | Which free providers are worth signing up for. |
| `docs/claude-chat-preferences.md` | Paste into claude.ai Settings → Personal preferences so chat uses the bridge. |
| `api/`, `lib/`, `scripts/` | The claude.ai / Cowork bridge (a Vercel function, MCP server). |

## Commands

- `ask-free "task"` – delegate a task; automatically picks a live free provider.  
- `ask-free -m bulk|code|quality|glm|big|reason` – select a model class.  
- `ask-free -f prompt.txt` – read the prompt from a file.  
- `ask-free -o out.md` – write the result to disk instead of inserting it into the context.  
- `ask-free --panel fast` – run several models at once (fast panel).  
- `free-stats` – show reliability metrics and lifetime token counts from the gateway’s call logs.  
- `free-scout` – list unused free capacity and detect broken aliases.  
- `free-grow --probe` / `free-grow --report` – measure new models and re-route aliases based on measured success rate.  
- `free-sync` – export the current roster status; optionally uploads it to a dashboard if `DELEGATION_DASHBOARD` points at a repo containing `scripts/sync-delegation.mjs`.  
- `add-providers` – interactively enter free-provider API keys into the gateway (one at a time).  
- `hear <file-or-folder>` – transcribe audio/video via Groq Whisper; writes a `.txt` beside each source file.  
- `see <file-or-folder> -o FILE` – image-to-text via a free vision model; writes the output to `FILE`.  
- `omni-stop` – emergency kill of the gateway.

## Setup – Claude Code (local)

1. Install Node.js, then install the gateway globally:  
   ```bash
   npm install -g omniroute
   ```
2. Copy `local/bin/*` into `%USERPROFILE%\.claude\bin` and add that folder to your `PATH`. The `.cmd` shims expect exactly that location.  
3. Run `add-providers` and paste the API key(s) for the free providers you have (one key is sufficient). Keys are stored in the gateway’s local encrypted database and in `~/.omniroute/.env` on your machine – never in this repository.  
4. Merge `local/hooks.settings.json` into `~/.claude/settings.json` (replace `YOUR_NAME` with your Windows user folder name).  
5. Paste `docs/PROTOCOL.md` into `~/.claude/CLAUDE.md` and copy `docs/omniroute-and-tools.md` to `~/.claude/reference/`.  
6. Test the installation:  
   ```bash
   ask-free "say hi"
   free-stats
   ```

## Setup – claude.ai chat and Cowork (bridge)

1. Import this repository as a Vercel project.  
2. In Vercel Settings → Deployment Protection, turn **off** Vercel Authentication (otherwise every request gets an SSO redirect and claude.ai cannot reach the endpoint). The only guard will be `MCP_SECRET` in the URL – use a long random value.  
3. Run the helper script to push environment variables:  
   ```powershell
   powershell -File scripts/push-env.ps1
   ```  
   The script prompts for `MCP_SECRET` and any provider keys, then pipes them directly to `vercel env add`.  
4. Deploy:  
   ```bash
   vercel deploy --prod --yes
   ```  
5. In claude.ai → Settings → Connectors, add a custom connector with the URL:  
   ```
   https://<your-project>.vercel.app/api/mcp/<MCP_SECRET>
   ```  
6. Paste `docs/claude-chat-preferences.md` into claude.ai Personal preferences.  

**Verification** – a wrong secret must return `401`. The correct secret lists three tools (`delegate`, `delegate_fetch`, `delegate_list`). Example check:  

```bash
curl -s -X POST https://<your-project>.vercel.app/api/mcp/<MCP_SECRET> -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Keeping the bridge’s routing in sync

`lib/aliases.json` is generated from the local `ask-free.mjs` (installed at `~/.claude/bin/lib/`) by `scripts/sync-aliases.mjs`. After a `free-grow` run changes routing, execute:

```bash
node scripts/sync-aliases.mjs && git commit -am "sync roster" && git push
```

## Rules that make it save

- Do not delegate work that yields fewer than ~30 lines of output.  
- Always verify the returned output; free models may invent specifics.  
- Never delegate the decision-making step; Claude must remain the final arbiter.  
- Route requests based on measured reliability, not on reputation alone.

## Honest limits

- The toolset is Windows-first (PowerShell); POSIX wrappers exist for Git Bash.  
- In claude.ai chat, tool results still enter the context, so the saving is smaller than with `ask-free -o`.  
- `delegate_fetch` references live only while the Vercel instance is warm.  
- The bridge works only for providers whose keys you have added to Vercel.  
- Free-tier capacities change; run `free-grow` periodically to re-measure and update routing.

## No keys in this repo

All secrets are stored in environment variables or local files that are ignored via `.gitignore`. No API keys or passwords are committed to this repository.

## License

MIT.