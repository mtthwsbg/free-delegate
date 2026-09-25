<#
  claude-free - Claude Code with a FREE model as the brain, for when the Claude
  quota runs out. Same CLAUDE.md, memory, skills, hooks, ask-free/hear/see, Chrome.

    claude-free                  pick the best live candidate and start
    claude-free -m <prov/model>  force a model
    claude-free --list           show candidates and their measured health
    claude-free -p "task" ...    anything else is passed through to claude

  Env only, for this one process. It does NOT use `omniroute run claude`: that
  command stops the shared gateway when it exits (killed a probe sweep, 2026-09-24).

  Lessons from the first real run (2026-09-24):
  - Claude Code sends its effort setting on every request; the gateway turns it
    into `reasoning_effort`, which Mistral (codestral) and Cohere reject with a
    400. Every candidate below was measured accepting effort + tool calls + a
    25k-token prompt through the gateway's Anthropic endpoint.
  - Gateway model discovery put all 1,755 gateway models, PAID ones included, into
    /model. Picking "no-think/openrouter/anthropic/claude-opus-4.6-low" hit a 402
    (paid OpenRouter, no credits) AND Claude Code saved that pick to the shared
    settings.json, breaking normal `claude` too. Discovery is now off, every model
    slot points at a free model, and settings.json is restored on exit.

  What is lost: claude.ai connectors (Gmail, Drive, Calendar, Supabase, Vercel...)
  are disabled whenever a gateway token is set.
#>
$ErrorActionPreference = 'Stop'

# Measured 2026-09-24 by REPLAYING a real Claude Code request (46 tools, full
# system prompt, effort + thinking) from ~/.omniroute/call_logs, not a toy one.
# A toy request passed on Gemini; the real one failed, because Gemini rejects the
# JSON-Schema keyword `prefixItems` in the built-in ArtifactData tool. With the
# Artifact tools disallowed (they need claude.ai anyway), Gemini answers in ~4s.
$candidates = @(
    'gemini/gemini-3.5-flash-lite',                         # 4s on the real request; generous free RPD
    'gemini/gemini-flash-lite-latest',                      # 6s
    'cloudflare-ai/@cf/google/gemma-4-26b-a4b-it',          # 6.5s, tool call ok; small daily quota
    'openrouter/cohere/north-mini-code:free',               # 7.8s, tool call ok; ~50 req/day
    'openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',  # 29s
    'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free'     # 46s
)
# The /model tiers, like Opus/Sonnet/Haiku in normal Claude Code. All three passed
# the real-request replay. Start on the middle one; /model switches in-session.
$tiers = [ordered]@{
    opus   = 'gemini/gemini-3.6-flash'          # smartest of the three, ~30s a turn
    sonnet = 'gemini/gemini-3.5-flash-lite'     # default: ~4s a turn
    haiku  = 'gemini/gemini-flash-lite-latest'  # background jobs: titles, classifier, subagents
}
$lite = $tiers.haiku

$model = $null; $list = $false; $dry = $false; $pass = @()
for ($i = 0; $i -lt $args.Count; $i++) {
    if ($args[$i] -eq '-m' -or $args[$i] -eq '--model') { $i++; $model = $args[$i] }
    elseif ($args[$i] -eq '--list') { $list = $true }
    elseif ($args[$i] -eq '--dry-run') { $dry = $true }
    else { $pass += $args[$i] }
}

$ledgerPath = Join-Path $env:USERPROFILE '.omniroute\probe-ledger.json'
$ledger = $null
if (Test-Path $ledgerPath) { $ledger = (Get-Content $ledgerPath -Raw | ConvertFrom-Json).models }
function Health($id) {
    if ($null -eq $ledger) { return 'unmeasured' }
    $v = $ledger.PSObject.Properties[$id]
    if ($null -eq $v) { return 'unmeasured' }
    if ($v.Value.ok -eq $false) { return 'DOWN' }
    return "$($v.Value.score)/6 $($v.Value.ms)ms"
}

if ($list) {
    foreach ($c in $candidates) { Write-Output ("  {0,-14} {1}" -f (Health $c), $c) }
    exit 0
}

# -m accepts a tier name (opus/sonnet/haiku) or any provider/model id.
if ($model -and $tiers.Contains($model)) { $model = $tiers[$model] }
if (-not $model) { $model = $tiers.sonnet }

# Gateway up (same warm-up the SessionStart hook uses), and its API key.
& (Join-Path $env:USERPROFILE '.claude\bin\lib\gateway-warm.ps1') | Out-Null
$envFile = Join-Path $env:USERPROFILE '.omniroute\.env'
$key = (Select-String -Path $envFile -Pattern '^OMNIROUTE_API_KEY=(\S+)' | Select-Object -Last 1).Matches.Groups[1].Value
if (-not $key) { Write-Output 'claude-free: no OMNIROUTE_API_KEY in ~/.omniroute/.env - run any ask-free call once first.'; exit 1 }

Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY -ErrorAction SilentlyContinue
$env:ANTHROPIC_BASE_URL = 'http://localhost:20128'
$env:CLAUDE_FREE = '1'   # delegation-reminder.ps1 switches to its light-mode reminder
$env:ANTHROPIC_AUTH_TOKEN = $key
$env:CLAUDE_CODE_AUTO_COMPACT_WINDOW = '190000'
# Every slot Claude Code can reach for is a free model, so nothing falls through
# to a paid claude-* route on the gateway. In /model, Opus/Sonnet/Haiku = these.
$env:ANTHROPIC_MODEL = $model
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = $tiers.opus
$env:ANTHROPIC_DEFAULT_FABLE_MODEL = $tiers.opus
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = $tiers.sonnet
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = $lite
$env:ANTHROPIC_SMALL_FAST_MODEL = $lite
$env:CLAUDE_CODE_SUBAGENT_MODEL = $lite
$env:CLAUDE_CODE_AUTO_MODE_MODEL = $lite
$env:CLAUDE_CODE_BG_CLASSIFIER_MODEL = $lite

# Settings guard: a /model or /effort pick inside this session is written to the
# SHARED settings.json. Remember model + modelSettings, and put them back on exit.
$settings = Join-Path $env:USERPROFILE '.claude\settings.json'
$saved = Join-Path $env:TEMP 'claude-free.settings-guard.json'
$guard = Join-Path $env:USERPROFILE '.claude\bin\lib\claude-free-guard.js'   # a file, not node -e: PS 5.1 mangles quotes in native args
if (Test-Path $settings) { node $guard save $settings $saved }

# Light mode. Smaller models follow CLAUDE.md to the letter: on a bare 'test' the
# first run loaded task-observer and launched an Explore agent (and plan mode, the
# global default, adds a launch-Explore-agents workflow). Normal permission mode
# plus these instructions make it behave like a plain assistant. No double quotes
# in this text: PS 5.1 mangles them in native arguments.
$light = 'You are running inside claude-free on a small free model, not Claude. In this session ONLY, ' +
    'these CLAUDE.md rules do NOT apply: the task-observer session-start protocol, the /clear suggestion, ' +
    'the delegation ledger, and delegating to ask-free. Answer greetings and short messages directly in ' +
    'one or two sentences with no tool calls. Do not launch subagents (Agent/Explore) or load skills unless ' +
    'the user asks for them. Keep tool use to the minimum the request needs, and ask before large changes.'

Write-Output ''
Write-Output "  claude-free -> $model  ($(Health $model))"
Write-Output '  - FREE model: weaker at long multi-step work. Keep tasks small and check its edits.'
Write-Output "  - /model  Opus = $($tiers.opus) (slow, smartest)  Sonnet = $($tiers.sonnet)  Haiku = $($tiers.haiku)"
Write-Output '  - Gemini quota out? restart with: claude-free -m cloudflare-ai/@cf/google/gemma-4-26b-a4b-it'
Write-Output '  - No claude.ai connectors here (Gmail, Drive, Calendar, Supabase, Vercel).'
Write-Output '  - Free tiers may log prompts: no resume, job, Gmail or personal data in this session.'
Write-Output ''

$claudeArgs = @('--model', $model, '--permission-mode', 'default',
    '--disallowedTools', 'Artifact,ArtifactData,ArtifactComments',
    '--append-system-prompt', $light) + $pass
if ($dry) {
    Write-Output '  [dry run] would launch: claude'
    foreach ($a in $claudeArgs) { Write-Output ('    ' + $a) }
    Get-ChildItem Env: | Where-Object { $_.Name -match '^(ANTHROPIC_(MODEL|DEFAULT_|BASE_URL|SMALL)|CLAUDE_CODE_(SUBAGENT|AUTO_MODE|BG_CLASS|ENABLE_GATEWAY))' } |
        ForEach-Object { Write-Output ('    env ' + $_.Name + '=' + $_.Value) }
    exit 0
}
try {
    & claude @claudeArgs
    $code = $LASTEXITCODE
} finally {
    if ((Test-Path $settings) -and (Test-Path $saved)) { node $guard restore $settings $saved }
}
exit $code
