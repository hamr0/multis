#!/data/data/com.termux/files/usr/bin/bash
# setup-termux.sh — install multis on Termux (Android)
#
# Usage:
#   curl -sL https://raw.githubusercontent.com/hamr0/multis/main/scripts/setup-termux.sh | bash
#   — or —
#   git clone https://github.com/hamr0/multis.git && cd multis && bash scripts/setup-termux.sh

set -e

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
green() { printf '\033[32m✓ %s\033[0m\n' "$*"; }
red() { printf '\033[31m✗ %s\033[0m\n' "$*"; }
dim() { printf '\033[2m%s\033[0m\n' "$*"; }

bold "multis — Termux setup"
echo ""

# ── 1. Check we're on Termux ──────────────────────────────
if [ ! -d /data/data/com.termux ]; then
  red "Not running on Termux. This script is for Android only."
  exit 1
fi
green "Termux detected"

# ── 2. Install system packages ────────────────────────────
bold "Installing system packages..."
pkg update -y
pkg install -y nodejs-lts git python make clang
green "System packages installed"

node_version=$(node -v)
dim "  Node.js $node_version"

# ── 3. Clone repo if not already in it ────────────────────
if [ -f package.json ] && grep -q '"name": "multis"' package.json 2>/dev/null; then
  MULTIS_DIR="$(pwd)"
  dim "  Already in multis directory"
else
  MULTIS_DIR="$HOME/multis"
  if [ -d "$MULTIS_DIR" ]; then
    dim "  $MULTIS_DIR already exists, pulling latest..."
    cd "$MULTIS_DIR"
    git pull --ff-only || true
  else
    bold "Cloning multis..."
    git clone https://github.com/hamr0/multis.git "$MULTIS_DIR"
    cd "$MULTIS_DIR"
  fi
fi

green "Source ready at $MULTIS_DIR"

# ── 4. Install npm packages (skip native compilation) ─────
bold "Installing npm packages..."
cd "$MULTIS_DIR"
npm install --ignore-scripts --legacy-peer-deps 2>&1 | tail -3
green "npm packages installed"

# ── 5. Build better-sqlite3 for Termux ────────────────────
bold "Compiling better-sqlite3 for Android/aarch64..."
dim "  This takes 1-2 minutes on a phone..."

TERMUX_PREFIX=/data/data/com.termux/files/usr
npx node-gyp rebuild \
  --directory=node_modules/better-sqlite3 \
  --nodedir="$TERMUX_PREFIX" \
  2>&1 | grep -E "(ok|error|ERR)" | tail -5

# Verify it loads
if node -e "require('better-sqlite3')" 2>/dev/null; then
  green "better-sqlite3 compiled and working"
else
  red "better-sqlite3 failed to compile"
  echo "  Try: cd node_modules/better-sqlite3 && npx node-gyp rebuild --nodedir=$TERMUX_PREFIX"
  exit 1
fi

# ── 6. Verify all core modules load ──────────────────────
bold "Verifying modules..."
FAILED=0
for mod in telegraf better-sqlite3 mammoth; do
  if node -e "require('$mod')" 2>/dev/null; then
    green "$mod"
  else
    red "$mod failed to load"
    FAILED=1
  fi
done

# pdfjs-dist may fail on Termux (canvas dependency) — non-critical,
# only used for PDF indexing via /index command
if node -e "import('pdfjs-dist/legacy/build/pdf.mjs')" 2>/dev/null; then
  green "pdfjs-dist"
else
  dim "  pdfjs-dist: skipped (PDF indexing won't work, everything else fine)"
fi

if [ $FAILED -ne 0 ]; then
  red "Core modules failed. Fix errors above before continuing."
  exit 1
fi

# ── 7. Set up wake lock reminder ──────────────────────────
echo ""
bold "Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Run the init wizard:"
echo "     cd $MULTIS_DIR && npx multis init"
echo ""
echo "  2. Start multis:"
echo "     npx multis start"
echo ""
echo "  3. Keep it alive (prevent Android from killing Termux):"
echo "     termux-wake-lock"
echo ""
dim "Tip: Install Termux:Boot from F-Droid to auto-start on boot."
dim "  mkdir -p ~/.termux/boot"
dim "  echo '#!/data/data/com.termux/files/usr/bin/bash' > ~/.termux/boot/multis.sh"
dim "  echo 'termux-wake-lock && cd $MULTIS_DIR && npx multis start' >> ~/.termux/boot/multis.sh"
dim "  chmod +x ~/.termux/boot/multis.sh"
