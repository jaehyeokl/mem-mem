# Install the memmem client binary (Windows x64) from GitHub Releases.
#
#   irm https://raw.githubusercontent.com/jaehyeokl/mem-mem/main/scripts/install.ps1 | iex
#   & ([scriptblock]::Create((irm .../install.ps1))) -Ref v0.2.0
#
# What it does: downloads memmem-windows-x64.exe and SHA256SUMS from the
# release, verifies the checksum, installs to
# $env:MEMMEM_INSTALL_DIR (default %LOCALAPPDATA%\Programs\memmem)\memmem.exe
# (backing up and restoring an existing binary if the new one fails
# `memmem --version`), and prints a PATH hint. It never changes PATH itself.
#
# Environment: MEMMEM_INSTALL_DIR, GITHUB_TOKEN (optional; sent only to
# api.github.com), MEMMEM_OWNER (release repository owner, see $Owner below).
param(
  [string]$Ref = "latest",
  [string]$Dir = ""
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3

# Release repository. Change the owner when the repository moves to an organization.
$Owner = if ($env:MEMMEM_OWNER) { $env:MEMMEM_OWNER } else { "jaehyeokl" }
$Repo = "mem-mem"
$Asset = "memmem-windows-x64.exe"
if (-not $Dir) {
  $Dir = if ($env:MEMMEM_INSTALL_DIR) { $env:MEMMEM_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\memmem" }
}

function Say([string]$m) { Write-Host "memmem-install: $m" }
# throw, not exit: under `irm | iex` exit would close the user's PowerShell window.
function Die([string]$m) { throw "memmem-install: error: $m" }

if ($Ref -ne "latest" -and $Ref -notmatch '^v[0-9]') { Die "-Ref must be latest or a tag like v0.2.0 (got: $Ref)" }
$arch = $env:PROCESSOR_ARCHITECTURE
if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
if ($arch -ne "AMD64") { Die "only a Windows x64 build is published (this machine: $arch)" }

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("memmem-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null
$lockPath = Join-Path $Dir ".memmem-install.lock"
$lock = $null
$dest = Join-Path $Dir "memmem.exe"
$backup = $null

try {
  if ($Ref -eq "latest") {
    $headers = @{ "User-Agent" = "memmem-install" }
    if ($env:GITHUB_TOKEN) { $headers["Authorization"] = "Bearer $($env:GITHUB_TOKEN)" }
    try {
      $tag = (Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/releases/latest" -Headers $headers).tag_name
    } catch { $tag = $null }
    if (-not $tag) { Die "could not resolve the latest release of $Owner/$Repo (set GITHUB_TOKEN if rate limited, or pass -Ref vX.Y.Z)" }
  } else { $tag = $Ref }
  $base = "https://github.com/$Owner/$Repo/releases/download/$tag"
  Say "installing memmem $tag ($Asset) into $Dir"

  $exe = Join-Path $tmp $Asset
  $sums = Join-Path $tmp "SHA256SUMS"
  try { Invoke-WebRequest -UseBasicParsing -Uri "$base/$Asset" -OutFile $exe } catch { Die "download failed: $base/$Asset" }
  try { Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $sums } catch { Die "download failed: $base/SHA256SUMS" }
  $want = $null
  foreach ($line in Get-Content $sums) {
    $parts = $line -split '\s+', 2
    if ($parts.Count -eq 2 -and ($parts[1] -eq $Asset -or $parts[1] -eq "*$Asset")) { $want = $parts[0].ToLower(); break }
  }
  if (-not $want) { Die "$Asset is not listed in SHA256SUMS" }
  $got = (Get-FileHash -Algorithm SHA256 -Path $exe).Hash.ToLower()
  if ($want -ne $got) { Die "checksum mismatch for $Asset (expected $want, got $got)" }
  Say "checksum ok"

  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  try {
    $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  } catch { Die "another install is running (close it, or delete $lockPath if it is stale)" }

  if (Test-Path $dest) {
    $backup = "$dest.bak"
    Copy-Item -Force $dest $backup
  }
  try {
    Copy-Item -Force $exe $dest
  } catch {
    if ($backup) { Move-Item -Force $backup $dest }
    Die "could not write $dest (is memmem running?)"
  }
  # No 2>&1: in Windows PowerShell 5.1 redirected native stderr becomes a terminating error.
  $ok = $true
  try { $version = & $dest --version; if ($LASTEXITCODE -ne 0) { $ok = $false } } catch { $ok = $false; $version = $_.Exception.Message }
  if (-not $ok) {
    if ($backup) { Move-Item -Force $backup $dest; Say "restored the previous memmem" } else { Remove-Item -Force $dest }
    Die "the new binary failed to run: $version"
  }
  if ($backup) { Remove-Item -Force $backup }
  Say "installed $dest (version $version)"

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $onPath = ($env:Path -split ';') + ($userPath -split ';') | Where-Object { $_ -and ($_.TrimEnd('\') -ieq $Dir.TrimEnd('\')) }
  if (-not $onPath) {
    Say "$Dir is not on your PATH. Add it for your user (then open a new terminal):"
    Say "  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';$Dir', 'User')"
  }
  Say "next: in your project run 'memmem setup' (first member) or 'memmem setup --member <name>' (teammates)"
} finally {
  if ($lock) { $lock.Close(); Remove-Item -Force -ErrorAction SilentlyContinue $lockPath }
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tmp
}
