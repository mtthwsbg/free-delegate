<#
  see.ps1 - image -> text through the local OmniRoute gateway. Free.

  Usage:
    see <file-or-folder> [more...]          results written to <folder>/ocr.txt
    see -o <file> <file-or-folder>          all results appended into <file>
    see -p "question" <file-or-folder>      ask something other than "transcribe"
    see -m <model-id> ...                   override the vision model

  Prints only the output path and a per-image status line. The extracted text
  goes to disk, never to stdout: a screenshot read into an agent context measured
  ~15,000 tokens, and printing the OCR back into that context would give most of
  the saving away. Read the file with grep or sed afterwards.

  IMAGES ARE DOWNSCALED BEFORE ENCODING, AND THAT IS NOT AN OPTIMISATION.
  Twelve full-size slides (~280 KB of base64 each) sent back-to-back killed the
  gateway process outright on 2026-09-03: the first answered, the rest returned
  empty bodies, and the health endpoint went to 000. Hence the longest-side
  resize, the hard payload cap, the serial pacing, and the rule below that an
  empty body counts as a failure rather than as an empty transcription.
#>

# 'Stop' for our own cmdlets, but NEVER around a native exe: in Windows
# PowerShell 5.1 any line a native command writes to stderr is wrapped in a
# NativeCommandError, which under 'Stop' terminates the whole script. ffmpeg
# printing a routine "no such file" for ONE image killed a 12-image run at
# image 9 and lost the summary. Native calls below are bracketed by Native().
$ErrorActionPreference = 'Stop'

function Native {
    # Run a native command without letting its stderr become a terminating error.
    param([scriptblock]$Block)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Block 2>$null | Out-Null } catch { }
    $ErrorActionPreference = $prev
}

$BASE     = 'http://127.0.0.1:20128'
$ENVFILE  = Join-Path $env:USERPROFILE '.omniroute/.env'
$LONGEST  = 768        # longest side in px after resize
$QUALITY  = 7          # ffmpeg -q:v; 2 = best, 31 = worst
$CAP      = 100000     # max base64 chars; over this we resize again, harder
$FALLBACK = 512
$IMGEXT   = @('.jpg','.jpeg','.png','.webp','.bmp','.gif')
$DEFAULT_PROMPT = 'Transcribe ALL text visible in this image verbatim. Output only the text.'
# Measured 2026-09-03 on a known slide, one call each, 60s ceiling:
#   cohere/command-a-vision-07-2025          3.3s  PASS   <- default
#   huggingface/Qwen/Qwen2.5-VL-72B-Instruct 6.6s  PASS
#   openrouter/qwen/qwen3-vl-30b-a3b         7.4s  PASS
#   openrouter/meta-llama/llama-4-scout      4.7s  weak (46 chars, truncated)
#   cloudflare-ai gemma-4-26b               59.0s  weak
#   gemini/gemini-3.6-flash                 60.0s  TIMEOUT
#   groq llama-4-scout / nvidia maverick / nvidia nemotron-vl: HTTP 400 (no image support on this route)
#   scaleway/pixtral-12b-2409:                     HTTP 429
# Three PASSes, three DIFFERENT providers -- same reasoning as ask-free's CHAIN:
# the binding constraint is rate limiting, so a fallback within one provider
# would fail all the way down exactly when load is highest.
$VISION_CHAIN = @(
    'cohere/command-a-vision-07-2025',
    'huggingface/Qwen/Qwen2.5-VL-72B-Instruct',
    'openrouter/qwen/qwen3-vl-30b-a3b-instruct'
)
$DEFAULT_MODEL  = $VISION_CHAIN[0]

function Fail($msg) { Write-Error "[see] $msg"; exit 1 }

# ---- args ----
$outFile = $null; $prompt = $DEFAULT_PROMPT; $model = $null; $inputs = @()
for ($i = 0; $i -lt $args.Count; $i++) {
    switch ($args[$i]) {
        '-o' { $i++; $outFile = $args[$i] }
        '-p' { $i++; $prompt  = $args[$i] }
        '-m' { $i++; $model   = $args[$i] }
        default { $inputs += $args[$i] }
    }
}
if ($inputs.Count -eq 0) {
    Write-Output 'usage: see [-o FILE] [-p "question"] [-m model] <file-or-folder> [...]'
    exit 1
}
# -m pins one model; otherwise walk the measured chain.
$chain = $VISION_CHAIN
if ($model) { $chain = @($model) }

# ---- preconditions ----
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { Fail 'ffmpeg not on PATH' }
if (-not (Test-Path $ENVFILE)) { Fail "no gateway env at $ENVFILE" }
$key = $null
foreach ($line in Get-Content $ENVFILE) {
    if ($line -match '^OMNIROUTE_API_KEY=(.+)$') { $key = $Matches[1].Trim() }
}
if (-not $key) { Fail 'OMNIROUTE_API_KEY not found; run ask-free once to mint one' }

# Health check before the first call, not after the first failure.
try {
    $h = Invoke-WebRequest -Uri "$BASE/api/monitoring/health" -TimeoutSec 5 -UseBasicParsing
    if ($h.StatusCode -ne 200) { throw }
} catch {
    Fail 'gateway is not answering; run the SessionStart warm hook (gateway-warm.ps1)'
}

# ---- expand inputs ----
$files = @()
foreach ($p in $inputs) {
    if (-not (Test-Path $p)) { Fail "no such path: $p" }
    $item = Get-Item -LiteralPath $p
    if ($item.PSIsContainer) {
        $files += Get-ChildItem -LiteralPath $p -File | Where-Object { $IMGEXT -contains $_.Extension.ToLower() } | Sort-Object Name
    } else {
        $files += $item
    }
}
if ($files.Count -eq 0) { Fail 'no image files found' }

if (-not $outFile) {
    $base = $files[0].DirectoryName
    $outFile = Join-Path $base 'ocr.txt'
}
$outDirParent = Split-Path -Parent $outFile
if ($outDirParent) { New-Item -ItemType Directory -Force -Path $outDirParent | Out-Null }
Set-Content -Path $outFile -Value '' -Encoding UTF8

$tmp = Join-Path $env:TEMP ("see-" + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

$promptJson = ConvertTo-Json $prompt -Compress   # escapes quotes/newlines for us
$consecutiveFailures = 0
$done = 0

try {
    foreach ($f in $files) {
        if ($consecutiveFailures -ge 2) {
            Write-Warning "[see] stopping: 2 consecutive failures, last was $($f.Name)"
            break
        }

        $small = Join-Path $tmp 'small.jpg'
        if (Test-Path $small) { Remove-Item $small -Force }
        Native { ffmpeg -loglevel error -y -i $f.FullName -vf "scale=w=${LONGEST}:h=${LONGEST}:force_original_aspect_ratio=decrease" -q:v $QUALITY $small }
        if (-not (Test-Path $small)) {
            Write-Warning "[see] ffmpeg produced nothing for $($f.Name)"
            $consecutiveFailures++
            continue
        }

        $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($small))
        if ($b64.Length -gt $CAP) {
            # Still too big: shrink harder rather than send it and risk the crash.
            Native { ffmpeg -loglevel error -y -i $f.FullName -vf "scale=w=${FALLBACK}:h=${FALLBACK}:force_original_aspect_ratio=decrease" -q:v 9 $small }
            $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($small))
        }
        if ($b64.Length -gt $CAP) {
            Write-Warning "[see] $($f.Name) still $([int]($b64.Length/1024)) KB after resize; skipped"
            $consecutiveFailures++
            continue
        }

        $body = Join-Path $tmp 'body.json'
        $respFile = Join-Path $tmp 'resp.json'
        $text = $null
        $used = $null

        foreach ($cand in $chain) {
            $json = '{"model":' + (ConvertTo-Json $cand -Compress) +
                    ',"messages":[{"role":"user","content":[{"type":"text","text":' + $promptJson +
                    '},{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,' + $b64 +
                    '"}}]}],"max_tokens":900}'
            [IO.File]::WriteAllText($body, $json)

            if (Test-Path $respFile) { Remove-Item $respFile -Force }
            Native { curl.exe -s -m 90 "$BASE/v1/chat/completions" -H "Authorization: Bearer $key" -H 'Content-Type: application/json' --data-binary "@$body" -o $respFile }

            if (Test-Path $respFile) {
                try {
                    $d = Get-Content $respFile -Raw | ConvertFrom-Json
                    $t = $d.choices[0].message.content
                    if ($t -and $t.Trim().Length -ge 2) { $text = $t; $used = $cand; break }
                } catch { }
            }
        }

        if (-not $text -or $text.Trim().Length -lt 2) {
            Write-Warning "[see] empty response for $($f.Name)"
            $consecutiveFailures++
            Start-Sleep -Seconds 2
            continue
        }

        Add-Content -Path $outFile -Value "--- $($f.Name)" -Encoding UTF8
        Add-Content -Path $outFile -Value $text -Encoding UTF8
        Add-Content -Path $outFile -Value '' -Encoding UTF8
        $consecutiveFailures = 0
        $done++
        Write-Output "ok  $($f.Name)  [$($used.Split('/')[0])]"

        # Serial with a gap. The crash came from back-to-back large bodies, so
        # pacing is part of the fix, not politeness.
        Start-Sleep -Milliseconds 700
    }
}
finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

Write-Output "[see] $done/$($files.Count) -> $outFile"
if ($done -lt $files.Count) { exit 1 }
exit 0
