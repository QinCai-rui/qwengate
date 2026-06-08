#!/usr/bin/env bash
set -uo pipefail

REPO="https://github.com/youssefvdel/qwen-gate.git"
DIR="qwen-gate"

info()  { printf '\033[1;34m→\033[0m %s\n' "$1"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$1"; }
fail()  { printf '\033[1;31m✗\033[0m %s\n' "$1"; exit 1; }

# ── Prerequisites ──────────────────────────────────────────────────

command -v git  >/dev/null 2>&1 || fail "git is required but not installed"
command -v node >/dev/null 2>&1 || fail "Node.js is required but not installed"
command -v npm  >/dev/null 2>&1 || fail "npm is required but not installed"

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  fail "Node.js >= 18 required (found v${NODE_VER})"
fi
ok "Prerequisites met (Node.js v$(node -v), npm $(npm -v))"

# ── Figure out where we are ────────────────────────────────────────

# Resolve the install location: current directory by default.
INSTALL_DIR="$(pwd)/$DIR"

# ── Clone or pull ──────────────────────────────────────────────────

if [ -d "$INSTALL_DIR" ]; then
  info "$DIR already exists — pulling latest"
  git -C "$INSTALL_DIR" pull --ff-only || fail "git pull failed in $INSTALL_DIR"
else
  info "Cloning $REPO"
  git clone "$REPO" "$INSTALL_DIR" || fail "git clone failed — check internet or permissions"
fi
ok "Repository ready at $INSTALL_DIR"

# ── Install dependencies ────────────────────────────────────────────

info "Installing dependencies in $DIR..."
cd "$INSTALL_DIR" || fail "Cannot cd to $INSTALL_DIR"

# If node_modules missing or empty, run install from scratch
if [ ! -d "node_modules" ] || [ -z "$(ls -A node_modules 2>/dev/null)" ]; then
  npm install --no-audit --no-fund 2>&1 | tail -5 || {
    info "npm install failed — retrying with verbose output..."
    npm install 2>&1 | tail -20 || fail "npm install failed. Check your network and run 'npm install' manually in $INSTALL_DIR"
  }
else
  # Already installed — just update
  npm install --no-audit --no-fund 2>&1 | tail -3
fi

if [ ! -d "node_modules" ] || [ -z "$(ls -A node_modules 2>/dev/null)" ]; then
  fail "node_modules is empty. Run 'cd $INSTALL_DIR && npm install' manually."
fi

PACKAGE_COUNT=$(find node_modules -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
ok "$PACKAGE_COUNT packages installed in $DIR"

# ── Build (optional) ────────────────────────────────────────────────

if command -v npx &>/dev/null; then
  info "Verifying tsx is available..."
  npx tsx --version >/dev/null 2>&1 && ok "tsx ready" || info "tsx not found — it will be installed on first 'qg' run"
fi

# ── Configuration ──────────────────────────────────────────────────

if [ ! -f "config.json" ]; then
  # Strip JSONC comments before writing to config.json
  sed 's|//.*||' config.example.jsonc > config.json
  info "Created config.json from example"
else
  ok "config.json already exists"
fi

# ── CLI symlinks ───────────────────────────────────────────────────

BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR" || fail "Cannot create $BIN_DIR"
chmod +x "$INSTALL_DIR/bin/qg"

ln -sf "$INSTALL_DIR/bin/qg" "$BIN_DIR/qg"
ln -sf "$INSTALL_DIR/bin/qg" "$BIN_DIR/qwengate"
ln -sf "$INSTALL_DIR/bin/qg" "$BIN_DIR/qwen-gate"

if ! command -v qg &>/dev/null; then
  printf '\n\033[1;33m⚠ %s is not in your PATH\033[0m\n' "$BIN_DIR"
  printf '  Add this to your shell profile and restart your terminal:\n'
  printf '  \033[1mexport PATH="%s:\$PATH"\033[0m\n\n' "$BIN_DIR"
fi
ok "CLI installed as 'qg', 'qwengate', 'qwen-gate'"

# ── Verify installation ────────────────────────────────────────────

info "Verifying installation..."
if "$INSTALL_DIR/bin/qg" --help >/dev/null 2>&1; then
  ok "Installation verified — qg is working"
else
  fail "Installation verification failed — try running 'npm install' manually in $INSTALL_DIR"
fi

# ── Done ───────────────────────────────────────────────────────────

PORT="${PORT:-26405}"

printf '\n\033[1;32m╔══════════════════════════════════════════════╗\033[0m\n'
printf '\033[1;32m║       Qwen Gate installed successfully      ║\033[0m\n'
printf '\033[1;32m╚══════════════════════════════════════════════╝\033[0m\n\n'
printf '  Start:     \033[1mqg\033[0m\n'
printf '  Update:    \033[1mqg update\033[0m\n'
printf '  Restart:   \033[1mqg restart\033[0m\n'
printf '  API:       http://localhost:%s/v1\n' "$PORT"
printf '  Dashboard: http://localhost:%s/dashboard\n' "$PORT"
printf '\n'
printf '  Add your Qwen accounts via the Dashboard → Accounts page.\n'
printf '\n'
