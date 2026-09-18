<#
  push-env.ps1 — put provider keys into this Vercel project.

  Run it from the project root. It asks for each key, one at a time, and pipes it
  straight to `vercel env add`. Press Enter to skip any provider you do not want
  on the hosted bridge — it works with whatever subset you give it, so starting
  with one key is a perfectly good first deploy.

  The keys are read from YOUR terminal and go to YOUR Vercel project. They never
  pass through a chat transcript, which is the whole reason this is a script you
  run rather than values pasted into a conversation.

  Your provider keys live encrypted inside the local OmniRoute database, not in a
  readable file, so they cannot be copied from there automatically — paste them
  from the provider dashboard or your password manager.
#>

$ErrorActionPreference = 'Stop'

$vars = @(
    @{ name = 'MCP_SECRET';        hint = 'a long random string YOU invent — it is the password in the connector URL' },
    @{ name = 'GROQ_API_KEY';      hint = 'console.groq.com' },
    @{ name = 'OPENROUTER_API_KEY';hint = 'openrouter.ai/keys' },
    @{ name = 'MISTRAL_API_KEY';   hint = 'console.mistral.ai' },
    @{ name = 'CEREBRAS_API_KEY';  hint = 'cloud.cerebras.ai' },
    @{ name = 'COHERE_API_KEY';    hint = 'dashboard.cohere.com' },
    @{ name = 'HF_API_KEY';        hint = 'huggingface.co/settings/tokens' },
    @{ name = 'NVIDIA_API_KEY';    hint = 'build.nvidia.com' },
    @{ name = 'GEMINI_API_KEY';    hint = 'aistudio.google.com/apikey' }
)

foreach ($v in $vars) {
    $value = Read-Host -Prompt ("{0}  ({1}) [Enter to skip]" -f $v.name, $v.hint)
    if ([string]::IsNullOrWhiteSpace($value)) { continue }
    foreach ($target in @('production', 'preview')) {
        $value | vercel env add $v.name $target
    }
    Write-Host ("  set {0}" -f $v.name) -ForegroundColor Green
}

Write-Host ""
Write-Host "Now redeploy so the new variables are picked up:  vercel --prod"
