<#
  delegation-reminder.ps1 - UserPromptSubmit hook.
  Prepended to EVERY prompt, so every line is paid for on every turn.
  The full routing table lives in CLAUDE.md; this is only the trigger.
#>
$ErrorActionPreference = 'SilentlyContinue'

# claude-free sessions (launcher sets CLAUDE_FREE=1): a small free model follows
# CLAUDE.md literally and answered a bare 'test' by loading skills and launching
# agents. A reminder placed next to the user's message is the only placement that
# changed that (8/8 plain answers in replay; appended system prompt: 0/3).
if ($env:CLAUDE_FREE -eq '1') {
    Write-Output @'
<claude-free light mode> You are a small free model standing in for Claude. The
CLAUDE.md session-start protocol (task-observer), the delegation ledger, ask-free
delegation and the /clear suggestion do NOT apply in this session. If the message
is a greeting, a test, or a simple question, reply in one or two sentences with NO
tool calls. Never launch subagents or load skills unless the user explicitly asks.
Use the fewest tools the request needs.
'@
    exit 0
}
Write-Output @'
[routing check] Bulk generation -> ask-free -m bulk -o FILE. Video/audio -> hear.
Image/screenshot -> see -o FILE (never Read an image). Codebase search / diff
review -> Anthropic subagent (paid, label it). <30 lines or judgment -> do it
yourself. Personal data (resume, jobs, Gmail) -> add --private. Building UI ->
check reference/ui-tools.md. End with the delegation ledger, or "Delegation: none".
'@
exit 0
