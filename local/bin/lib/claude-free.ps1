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

$candidates = @(
    'gemini/gemini-3.6-flash',                              # tools ok, 1.8s, 1M ctx
    'gemini/gemini-3.5-flash-lite',                         # tools ok, 2.1s, 25k prompt 3s
    'nvidia/google/gemma-4-31b-it',                         # tools ok, 13s
    'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',    # tools ok, 12s, ~50 req/day
    'openrouter/cohere/north-mini-code:free',               # tools ok, 0.8s, coding model
    'cloudflare-ai/@cf/google/gemma-4-26b-a4b-it'           # tools ok, 0.7s, small daily quota
)
$lite = 'gemini/gemini-3.5-flash-lite'   # background jobs: titles, classifier, subagents

$model = $null; $list = $false; $pass = @()
for ($i = 0; $i -lt $args.Count; $i++) {
    if ($args[$i] -eq '-m' -or $args[$i] -eq '--model') { $i++; $model = $args[$i] }
    elseif ($args[$i] -eq '--list') { $list = $true }
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

$live = @($candidates | Where-Object { (Health $_) -ne 'DOWN' })
if ($live.Count -eq 0) { $live = $candidates }
if (-not $model) { $model = $live[0] }
$second = @($live | Where-Object { $_ -ne $model })[0]
if (-not $second) { $second = $model }

# Gateway up (same warm-up the SessionStart hook uses), and its API key.
& (Join-Path $env:USERPROFILE '.claude\bin\lib\gateway-warm.ps1') | Out-Null
$envFile = Join-Path $env:USERPROFILE '.omniroute\.env'
$key = (Select-String -Path $envFile -Pattern '^OMNIROUTE_API_KEY=(\S+)' | Select-Object -Last 1).Matches.Groups[1].Value
if (-not $key) { Write-Output 'claude-free: no OMNIROUTE_API_KEY in ~/.omniroute/.env - run any ask-free call once first.'; exit 1 }

Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY -ErrorAction SilentlyContinue
$env:ANTHROPIC_BASE_URL = 'http://localhost:20128'
$env:ANTHROPIC_AUTH_TOKEN = $key
$env:CLAUDE_CODE_AUTO_COMPACT_WINDOW = '190000'
# Every slot Claude Code can reach for is a free model, so nothing falls through
# to a paid claude-* route on the gateway. In /model, Opus/Sonnet/Haiku = these.
$env:ANTHROPIC_MODEL = $model
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = $model
$env:ANTHROPIC_DEFAULT_FABLE_MODEL = $model
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = $second
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

Write-Output ''
Write-Output "  claude-free -> $model  ($(Health $model))"
Write-Output '  - FREE model: weaker at long multi-step work. Keep tasks small and check its edits.'
Write-Output "  - /model: Opus = $model, Sonnet = $second, Haiku = $lite. Never pick claude/anthropic names."
Write-Output '  - No claude.ai connectors here (Gmail, Drive, Calendar, Supabase, Vercel).'
Write-Output '  - Free tiers may log prompts: no resume, job, Gmail or personal data in this session.'
Write-Output ''

try {
    & claude --model $model @pass
    $code = $LASTEXITCODE
} finally {
    if ((Test-Path $settings) -and (Test-Path $saved)) { node $guard restore $settings $saved }
}
exit $code
