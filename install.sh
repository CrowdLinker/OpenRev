#!/usr/bin/env bash
# OpenRev one-command installer
#
#   curl -fsSL https://raw.githubusercontent.com/CrowdLinker/OpenRev/main/install.sh | bash
#
# Options (pass after `bash -s --`):  --target cloudflare|docker|node  --dir <folder>
set -euo pipefail

REPO="${OPENREV_REPO:-https://github.com/CrowdLinker/OpenRev.git}"
BRANCH="${OPENREV_BRANCH:-main}"
DIR="${OPENREV_DIR:-openrev}"
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
info() { printf "\033[35m◆\033[0m %s\n" "$*"; }
fail() { printf "\033[31m✖ %s\033[0m\n" "$*" >&2; exit 1; }

echo
bold "  ▲ OpenRev — open-source, revenue-first web analytics"
echo

command -v git >/dev/null 2>&1 || fail "git is required. Install it from https://git-scm.com/downloads"

if [ -d "$DIR/.git" ]; then
  info "Updating existing checkout in ./$DIR"
  git -C "$DIR" pull --ff-only
else
  info "Downloading OpenRev into ./$DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR"

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'
}

if ! node_ok; then
  if command -v docker >/dev/null 2>&1; then
    info "Node.js 22.13+ not found — starting OpenRev with Docker instead"
    if [ ! -f .env ]; then
      SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
      printf "PUBLIC_URL=http://localhost:3000\nPORT=3000\nOPENREV_SECRET=%s\n" "$SECRET" > .env
    fi
    docker compose up -d --build
    echo
    bold "✔ OpenRev is running on http://localhost:3000 — open it to create your admin account."
    exit 0
  fi
  fail "Node.js 22.13+ (https://nodejs.org) or Docker (https://docs.docker.com/get-docker/) is required."
fi

info "Installing dependencies"
npm install --no-audit --no-fund --loglevel=error

if ( : < /dev/tty ) 2>/dev/null; then
  node scripts/setup.mjs ${ARGS[@]+"${ARGS[@]}"} < /dev/tty
else
  node scripts/setup.mjs ${ARGS[@]+"${ARGS[@]}"}
fi
