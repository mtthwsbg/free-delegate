<#
  delegation-reminder.ps1 - UserPromptSubmit hook.
  Prepended to EVERY prompt, so every line is paid for on every turn.
  The full routing table lives in CLAUDE.md; this is only the trigger.
#>
$ErrorActionPreference = 'SilentlyContinue'
Write-Output @'
[routing check] Bulk generation -> ask-free -m bulk -o FILE. Video/audio -> hear.
Image/screenshot -> see -o FILE (never Read an image). Codebase search / diff
review -> Anthropic subagent (paid, label it). <30 lines or judgment -> do it
yourself. End the reply with the delegation ledger, or "Delegation: none".
'@
exit 0
