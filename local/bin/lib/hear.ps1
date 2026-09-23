<#
  hear.ps1 - audio/video -> text via Groq Whisper. Free.

  Usage:
    hear <file-or-folder> [more...]     transcript written beside each input
    hear -o <dir> <file-or-folder>      transcripts collected in <dir>

  Prints only the output paths. The transcript never goes to stdout, because the
  whole point is to keep the text out of the caller's context until it is grepped.

  Goes DIRECT to Groq, not through the OmniRoute gateway: the gateway proxies
  /v1/chat/completions only and has no audio endpoint. That is why this is its
  own command rather than a flag on ask-free.

  Uses curl.exe for the multipart upload. Windows PowerShell 5.1 has no -Form
  parameter on Invoke-RestMethod, so a native multipart POST is not available here.
#>

# 'Stop' for our own cmdlets, but NEVER around a native exe: in Windows
# PowerShell 5.1 a native command's stderr is wrapped in a NativeCommandError,
# which under 'Stop' terminates the script. One unreadable input would otherwise
# abort the whole batch instead of being counted as a single failure.
$ErrorActionPreference = 'Stop'

function Native {
    param([scriptblock]$Block)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Block 2>$null | Out-Null } catch { }
    $ErrorActionPreference = $prev
}

$MODEL   = 'whisper-large-v3-turbo'
$ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions'
$KEYFILE = Join-Path $env:USERPROFILE '.claude/groq-key.txt'
$MEDIA   = @('.mp4','.mov','.mkv','.webm','.avi','.mp3','.m4a','.wav','.ogg','.flac','.aac')

function Fail($msg) { Write-Error "[hear] $msg"; exit 1 }

# ---- args ----
$outDir = $null
$inputs = @()
for ($i = 0; $i -lt $args.Count; $i++) {
    if ($args[$i] -eq '-o') { $i++; $outDir = $args[$i] }
    else { $inputs += $args[$i] }
}
if ($inputs.Count -eq 0) {
    Write-Output 'usage: hear [-o OUTDIR] <file-or-folder> [...]'
    exit 1
}

# ---- preconditions ----
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { Fail 'ffmpeg not on PATH' }
if (-not (Test-Path $KEYFILE)) { Fail "no Groq key at $KEYFILE" }
$key = (Get-Content $KEYFILE -Raw).Trim()
if (-not $key) { Fail "$KEYFILE is empty" }
if ($outDir) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

# ---- expand inputs to a file list ----
$files = @()
foreach ($p in $inputs) {
    if (-not (Test-Path $p)) { Fail "no such path: $p" }
    $item = Get-Item -LiteralPath $p
    if ($item.PSIsContainer) {
        $files += Get-ChildItem -LiteralPath $p -File | Where-Object { $MEDIA -contains $_.Extension.ToLower() }
    } else {
        $files += $item
    }
}
if ($files.Count -eq 0) { Fail 'no media files found' }

# ---- transcribe ----
$tmp = Join-Path $env:TEMP ("hear-" + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$consecutiveFailures = 0
$done = 0

try {
    foreach ($f in $files) {
        # Failure budget: two in a row means the provider is down, not that this
        # one file is odd. Same discipline as ask-free -- stop, name it, do not
        # grind through the rest producing empty files.
        if ($consecutiveFailures -ge 2) {
            Write-Warning "[hear] stopping: 2 consecutive failures, last was $($f.Name)"
            break
        }

        $stem = [IO.Path]::GetFileNameWithoutExtension($f.Name)
        $safe = ($stem -replace '[^A-Za-z0-9._-]', '_')
        if ($safe.Length -gt 60) { $safe = $safe.Substring(0,60) }

        $dest = $outDir
        if (-not $dest) { $dest = $f.DirectoryName }
        $txt = Join-Path $dest "$safe.txt"
        $mp3 = Join-Path $tmp "$safe.mp3"

        # mono 16 kHz, lowest usable bitrate -- the smallest form Whisper accepts.
        Native { ffmpeg -loglevel error -y -i $f.FullName -vn -ac 1 -ar 16000 -c:a libmp3lame -q:a 9 $mp3 }
        if (-not (Test-Path $mp3)) {
            Write-Warning "[hear] ffmpeg produced nothing for $($f.Name)"
            $consecutiveFailures++
            continue
        }

        if (Test-Path $txt) { Remove-Item $txt -Force }
        Native { curl.exe -s -m 300 $ENDPOINT -H "Authorization: Bearer $key" -F "file=@$mp3" -F "model=$MODEL" -F 'response_format=text' -o $txt }

        # An empty body is a failure, not an empty transcript. Treating it as
        # output is how a dead provider silently fills a folder with blanks.
        $size = 0
        if (Test-Path $txt) { $size = (Get-Item $txt).Length }
        if ($size -lt 2) {
            Write-Warning "[hear] empty response for $($f.Name)"
            if (Test-Path $txt) { Remove-Item $txt -Force }
            $consecutiveFailures++
            continue
        }

        $consecutiveFailures = 0
        $done++
        Write-Output $txt
    }
}
finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

Write-Output "[hear] $done/$($files.Count) transcribed"
if ($done -lt $files.Count) { exit 1 }
exit 0
