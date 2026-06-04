# Qwen Gate Windows Installer
# Run: powershell -ExecutionPolicy Bypass -File install.ps1

$ErrorActionPreference = "Stop"
$Repo = "https://github.com/youssefvdel/qwen-gate.git"
$Dir = "$PWD\qwen-gate"

function Info  { Write-Host "→ $args" -ForegroundColor Cyan }
function Ok    { Write-Host "✓ $args" -ForegroundColor Green }
function Fail  { Write-Host "✗ $args" -ForegroundColor Red; exit 1 }

# ── Prerequisites ──

Info "Checking prerequisites..."

try { $null = Get-Command git -ErrorAction Stop } catch { Fail "git is required (https://git-scm.com)" }
try { $null = Get-Command node -ErrorAction Stop } catch { Fail "Node.js is required (https://nodejs.org)" }
try { $null = Get-Command npm -ErrorAction Stop } catch { Fail "npm is required (installed with Node.js)" }

$NodeVer = (node -v) -replace 'v', '' -replace '\..*', ''
if ([int]$NodeVer -lt 18) { Fail "Node.js >= 18 required (found v$(node -v))" }

Ok "Prerequisites met (Node.js $(node -v), npm $(npm -v))"

# ── Clone ──

if (Test-Path "$Dir") {
  Info "$Dir already exists — pulling latest"
  git -C "$Dir" pull --ff-only
} else {
  Info "Cloning $Repo"
  git clone "$Repo" "$Dir"
}
Ok "Repository ready"

# ── Install ──

Info "Installing dependencies..."
Set-Location "$Dir"
npm install
Ok "Dependencies installed"

# ── Configuration ──

if (-not (Test-Path "$Dir\config.json")) {
  Copy-Item "$Dir\config.example.jsonc" "$Dir\config.json"
  Info "Created config.json from example — edit it before starting"
} else {
  Ok "config.json already exists"
}

# ── PATH Add ──

$BinDir = "$Dir\bin"
$CurrentPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($CurrentPath -notlike "*$BinDir*") {
  [Environment]::SetEnvironmentVariable("Path", "$CurrentPath;$BinDir", "User")
  Info "Added $BinDir to your PATH (changes apply to new terminals)"
}
Ok "CLI available as qg"

# ── Done ──

Write-Host "`n╔══════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║       Qwen Gate installed successfully      ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Green

Write-Host "`n  Start:     qg" -ForegroundColor White
Write-Host "  Update:    qg update" -ForegroundColor White
Write-Host "  Restart:   qg restart" -ForegroundColor White
Write-Host "  API:       http://localhost:26405/v1"
Write-Host "  Dashboard: http://localhost:26405/dashboard"
Write-Host "`n  Add your Qwen accounts via the Dashboard -> Accounts page.`n"
