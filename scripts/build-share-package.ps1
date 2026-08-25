param(
  [string]$OutputPath = "dist\jp-admin-self-hosted.zip"
)

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$resolvedOutput = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $OutputPath))
$distRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot 'dist'))
if (-not $resolvedOutput.StartsWith($distRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'OutputPath must stay inside this repository\dist'
}

New-Item -ItemType Directory -Force -Path $distRoot | Out-Null
if (Test-Path -LiteralPath $resolvedOutput) {
  Remove-Item -LiteralPath $resolvedOutput -Force
}

$excluded = @(
  ':(exclude).env',
  ':(exclude)CURRENT_STATE.md',
  ':(exclude)AI_HANDOFF.md',
  ':(exclude)legacy-cohort.js',
  ':(exclude)node_modules',
  ':(exclude)dist',
  ':(glob,exclude)**/*.log'
)
& git -C $repoRoot archive --format=zip --output=$resolvedOutput HEAD -- . @excluded
if ($LASTEXITCODE -ne 0) { throw 'git archive failed' }

Write-Host "Created sanitized mentor package: $resolvedOutput"
Write-Host 'The package excludes operational state, handoff history, logs, .env, node_modules, and dist; privacy-safe guide screenshots are included.'
