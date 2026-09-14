[CmdletBinding()]
param([switch]$SkipInstall)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$frontendRoot = Join-Path $projectRoot 'frontend'
$outputRoot = Join-Path $projectRoot 'dist'

foreach ($command in @('node', 'npm.cmd', 'go')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "$command is required to build symmd."
    }
}

Push-Location $frontendRoot
try {
    if (-not $SkipInstall) { & npm.cmd ci }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "Frontend build failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$output = Join-Path $outputRoot 'symmd.exe'
go build -trimpath -ldflags='-H windowsgui' -o $output .\cmd\symmd
if ($LASTEXITCODE -ne 0) { throw "Go build failed with exit code $LASTEXITCODE" }
Write-Host "Built $output"
