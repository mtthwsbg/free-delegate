<#
  claude-free - Claude Code with a FREE model as the brain, for when the Claude
  quota runs out. Same CLAUDE.md, memory, skills, hooks, ask-free/hear/see, Chrome.

    claude-free                  pick the best live candidate and start
    claude-free -m <prov/model>  force a model
    claude-free --list           show candidates and their measured health
    claude-free -p "task" ...    anything else is passed through to claude

  Env only, for this one process. It never writes settings.json. It does NOT use
  `omniroute run claude`: that command stops the shared gateway when it exits,
  which killed a probe sweep mid-run on 2026-09-24.

  What is lost: claude.ai connectors (Gmail, Drive, Calendar, Supabase, Vercel...)
  are disabled whenever a gateway token is set; Claude Code says so at start.
#>
$ErrorActionPreference = 'Stop'

# Ordered by what Claude Code needs: tool calling, a long context (the harness
# prompt alone is tens of thousands of tokens), and a free allowance that
# survives an agent loop. Groq is last: its free tier caps tokens per minute
# far below one Claude Code request.
$candidates = @(
    'mistral/codestral-latest',                             # 256k ctx, large free monthly allowance
    'openrouter/nvidia/nemotron-3-super-120b-a12b:free',    # 262k ctx, ~50 requests/day free
    'cohere/command-a-plus-05-2026',                        # 256k ctx, trial ~1000 calls/month
    'groq/openai/gpt-oss-120b'                              # 131k ctx, low tokens-per-minute
)

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

if (-not $model) {
    foreach ($c in $candidates) { if ((Health $c) -ne 'DOWN') { $model = $c; break } }
    if (-not $model) { $model = $candidates[0] }
}

# Gateway up (same warm-up the SessionStart hook uses), and its API key.
& (Join-Path $env:USERPROFILE '.claude\bin\lib\gateway-warm.ps1') | Out-Null
$envFile = Join-Path $env:USERPROFILE '.omniroute\.env'
$key = (Select-String -Path $envFile -Pattern '^OMNIROUTE_API_KEY=(\S+)' | Select-Object -Last 1).Matches.Groups[1].Value
if (-not $key) { Write-Output 'claude-free: no OMNIROUTE_API_KEY in ~/.omniroute/.env - run any ask-free call once first.'; exit 1 }

Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
$env:ANTHROPIC_BASE_URL = 'http://localhost:20128'
$env:ANTHROPIC_AUTH_TOKEN = $key
$env:ANTHROPIC_MODEL = $model
$env:ANTHROPIC_SMALL_FAST_MODEL = $model
$env:CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '1'
$env:CLAUDE_CODE_AUTO_COMPACT_WINDOW = '190000'
# Free models reject Claude's thinking/effort parameters ("reasoning_effort is
# not enabled for this model" from codestral, 2026-09-24).
$env:MAX_THINKING_TOKENS = '0'

Write-Output ''
Write-Output "  claude-free -> $model  ($(Health $model))"
Write-Output '  - FREE model: weaker at long multi-step work. Keep tasks small and check its edits.'
Write-Output '  - No claude.ai connectors here (Gmail, Drive, Calendar, Supabase, Vercel).'
Write-Output '  - Free tiers may log prompts: no resume, job, Gmail or personal data in this session.'
Write-Output '  - Switch model: claude-free -m <provider/model>   |   candidates: claude-free --list'
Write-Output ''

& claude @pass
exit $LASTEXITCODE
