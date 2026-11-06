#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Test-NodeVersion([string]$version) {
    $parts = $version.Split('.')
    if ($parts.Count -lt 2) { return $false }
    $major = [int]$parts[0]
    $minor = [int]$parts[1]
    return ($major -gt 22) -or ($major -eq 22 -and $minor -ge 12) -or ($major -eq 20 -and $minor -ge 19)
}

$currentNode = ''
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand) { $currentNode = (& node --version).TrimStart('v') }
if (-not (Test-NodeVersion $currentNode)) {
    $nvmRoot = if ($env:NVM_HOME) { $env:NVM_HOME.TrimEnd('\') } else { Join-Path $env:LOCALAPPDATA 'nvm' }
    $candidate = Get-ChildItem $nvmRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^v\d+\.\d+\.\d+$' } |
        Sort-Object { [version]$_.Name.TrimStart('v') } -Descending |
        Where-Object { Test-NodeVersion $_.Name.TrimStart('v') } |
        Select-Object -First 1
    if (-not $candidate) {
        throw "Node.js 20.19+ is required (current: $currentNode). Install or switch Node.js and retry."
    }
    $env:Path = "$($candidate.FullName);$env:Path"
    Write-Host "Using Node.js $($candidate.Name) from $nvmRoot"
}

$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$nsisDir = Join-Path $root 'src-tauri\target\release\bundle\nsis'
$portableExe = Join-Path $root 'src-tauri\target\release\winpaste-app.exe'
$outDir = Join-Path $root 'artifacts\release'

Write-Host '==> 1/2 Building NSIS installer...'
& npm.cmd run build:installer
if ($LASTEXITCODE -ne 0) { throw "Installer build failed (exit $LASTEXITCODE)" }

Write-Host '==> 2/2 Building portable single-file exe...'
& npm.cmd run build:portable
if ($LASTEXITCODE -ne 0) { throw "Portable build failed (exit $LASTEXITCODE)" }

if (-not (Test-Path $nsisDir)) { throw "NSIS output directory not found: $nsisDir" }
if (-not (Test-Path $portableExe)) { throw "Portable exe not found: $portableExe" }

$setup = Get-ChildItem $nsisDir -Filter '*-setup.exe' -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if (-not $setup) { throw "No NSIS installer found in $nsisDir" }

New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$installerOut = Join-Path $outDir ("WinPaste_{0}_x64-setup.exe" -f $version)
$portableOut = Join-Path $outDir ("WinPaste_{0}_x64-portable.exe" -f $version)
Copy-Item $setup.FullName $installerOut -Force
Copy-Item $portableExe $portableOut -Force

Write-Host ''
Write-Host 'Release files:'
Write-Host "  $installerOut"
Write-Host "  $portableOut"
