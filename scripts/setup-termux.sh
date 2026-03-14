#!/data/data/com.termux/files/usr/bin/bash
# setup-termux.sh — one-shot multis installer for Android (Termux)
#
# Run this in Termux:
#   curl -sL https://raw.githubusercontent.com/hamr0/multis/main/scripts/setup-termux.sh | bash
#
# What it does:
#   1. Installs system packages (Node.js, git, build tools)
#   2. Clones the multis repo
#   3. Installs npm packages
#   4. Compiles better-sqlite3 for Android/aarch64
#   5. Verifies everything works
#   6. Runs the interactive setup wizard (Telegram + LLM)
#   7. Sets up auto-start on boot (optional)

set -e

TERMUX_PREFIX=/data/data/com.termux/files/usr

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
green() { printf '\033[32m✓ %s\033[0m\n' "$*"; }
red()   { printf '\033[31m✗ %s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m! %s\033[0m\n' "$*"; }

cat << 'BANNER'

  ╔╦╗╦ ╦╦ ╔╦╗╦╔═╗
  ║║║║ ║║  ║ ║╚═╗
  ╩ ╩╚═╝╩═╝╩ ╩╚═╝
  Android Setup

BANNER

# ── Pre-flight ────────────────────────────────────────────
if [ ! -d /data/data/com.termux ]; then
  red "Not running in Termux. This script is for Android only."
  echo ""
  echo "For Linux/Mac/VPS, just run:"
  echo "  git clone https://github.com/hamr0/multis.git"
  echo "  cd multis && npm install && npx multis init"
  exit 1
fi

# Check storage permission (needed for Termux to access shared storage)
if [ ! -d ~/storage ]; then
  bold "Granting storage access..."
  termux-setup-storage
  sleep 2
fi

green "Termux detected"
echo ""

# ── 1. System packages ───────────────────────────────────
bold "Step 1/5 — System packages"

pkg update -y 2>&1 | tail -1
pkg install -y nodejs-lts git python make clang 2>&1 | tail -1

green "Installed: Node.js $(node -v), git, python, make, clang"
echo ""

# ── 2. Clone multis ──────────────────────────────────────
bold "Step 2/5 — Download multis"

MULTIS_DIR="$HOME/multis"

if [ -f "$MULTIS_DIR/package.json" ]; then
  cd "$MULTIS_DIR"
  git pull --ff-only 2>&1 | tail -1
  dim "  Updated existing install"
else
  git clone https://github.com/hamr0/multis.git "$MULTIS_DIR" 2>&1 | tail -2
  cd "$MULTIS_DIR"
fi

green "Source ready at $MULTIS_DIR"
echo ""

# ── 3. Install npm packages ─────────────────────────────
bold "Step 3/5 — Install packages"

# --ignore-scripts: skip native compilation (we do it manually next)
# --legacy-peer-deps: bare-agent wants newer better-sqlite3, works fine with current
npm install --ignore-scripts --legacy-peer-deps 2>&1 | tail -3

green "npm packages installed"
echo ""

# ── 4. Compile better-sqlite3 ───────────────────────────
bold "Step 4/5 — Compile SQLite for Android"
dim "  This takes 1-2 minutes..."

# node-gyp on Termux needs --nodedir pointed at Termux's prefix
# (default gyp looks for android_ndk_path which doesn't exist)
npx node-gyp rebuild \
  --directory=node_modules/better-sqlite3 \
  --nodedir="$TERMUX_PREFIX" \
  2>&1 | tail -2

if node -e "require('better-sqlite3')" 2>/dev/null; then
  green "better-sqlite3 compiled"
else
  red "better-sqlite3 failed to compile"
  echo ""
  echo "  Try manually:"
  echo "  cd $MULTIS_DIR/node_modules/better-sqlite3"
  echo "  npx node-gyp rebuild --nodedir=$TERMUX_PREFIX"
  exit 1
fi
echo ""

# ── 5. Verify ────────────────────────────────────────────
bold "Step 5/5 — Verify"

ALL_OK=1
for mod in telegraf better-sqlite3 mammoth; do
  if node -e "require('$mod')" 2>/dev/null; then
    green "$mod"
  else
    red "$mod"
    ALL_OK=0
  fi
done

# pdfjs-dist may fail on Termux (canvas dep) — only needed for PDF indexing
if node -e "import('pdfjs-dist/legacy/build/pdf.mjs')" 2>/dev/null; then
  green "pdfjs-dist"
else
  warn "pdfjs-dist unavailable (PDF indexing disabled, everything else works)"
fi

if [ $ALL_OK -eq 0 ]; then
  red "Some core modules failed. Fix errors above."
  exit 1
fi

echo ""
green "Installation complete!"
echo ""

# ── Run multis init ──────────────────────────────────────
bold "Starting setup wizard..."
dim "  On Android, only Telegram is supported as a platform."
dim "  You'll need your Telegram bot token (from @BotFather)."
echo ""

npx multis init

# ── Auto-start on boot (optional) ────────────────────────
echo ""
bold "Auto-start on boot?"
dim "  Requires Termux:Boot app from F-Droid."
printf "Set up auto-start? (y/N): "
read -r AUTOSTART

if [ "$AUTOSTART" = "y" ] || [ "$AUTOSTART" = "Y" ]; then
  mkdir -p ~/.termux/boot
  cat > ~/.termux/boot/multis.sh << BOOT
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
cd $MULTIS_DIR
npx multis start
BOOT
  chmod +x ~/.termux/boot/multis.sh
  green "Auto-start configured"
  dim "  Install Termux:Boot from F-Droid if you haven't already"
else
  dim "  Skipped. You can start manually with:"
  dim "  cd $MULTIS_DIR && npx multis start"
fi

# ── Done ─────────────────────────────────────────────────
echo ""
bold "All done! To start multis:"
echo ""
echo "  cd $MULTIS_DIR"
echo "  termux-wake-lock"
echo "  npx multis start"
echo ""
dim "To keep Termux alive, disable battery optimization for Termux"
dim "in Android Settings > Apps > Termux > Battery > Unrestricted."
