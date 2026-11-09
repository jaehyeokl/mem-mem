#!/bin/sh
# Install memmem-server (and Letta Code, if needed) from GitHub Releases.
#
#   curl -fsSL https://raw.githubusercontent.com/jaehyeokl/mem-mem/main/scripts/install-server.sh | sh
#   curl -fsSL .../install-server.sh | sh -s -- --ref v0.2.0
#
# memmem-server is not on the npm registry: the package tarball comes from the
# GitHub Release, verified against the release's SHA256SUMS.
#
# What it does: checks Node.js >= 24.22, npm and git (it never installs Node;
# it prints how to), installs Letta Code from npm if it is missing or older
# than the supported range, downloads memmem-server-<version>.tgz and
# SHA256SUMS from the release, verifies the checksum, runs
# `npm i -g ./memmem-server-<version>.tgz`, and checks `memmem-server version`.
# It never uses sudo and never edits shell startup files.
#
# Environment: MEMMEM_SERVER_INSTALL_PREFIX (npm --prefix for both packages;
# default: npm's global prefix), GITHUB_TOKEN (optional; sent only to
# api.github.com, whose anonymous rate limit `latest` uses), MEMMEM_OWNER
# (release repository owner, see OWNER below).
set -eu

# Release repository. Change OWNER when the repository moves to an organization.
OWNER="${MEMMEM_OWNER:-jaehyeokl}"
REPO="mem-mem"
REF="latest"
PREFIX="${MEMMEM_SERVER_INSTALL_PREFIX:-}"

# Letta Code: the version installed when it is missing or too old. Keep it in
# sync with `ARG LETTA_CODE_VERSION` in packages/server/Dockerfile and with the
# peer range in packages/server/package.json (^0.34.41 = >=0.34.41 <0.35.0).
LETTA_CODE_VERSION="0.34.41"
LETTA_CODE_MIN="0.34.41"
LETTA_CODE_BELOW="0.35.0"
NODE_MIN="24.22.0"

say() { printf '%s\n' "memmem-server-install: $*"; }
warn() { printf '%s\n' "memmem-server-install: warning: $*" >&2; }
die() { printf '%s\n' "memmem-server-install: error: $*" >&2; exit 1; }

usage() {
  cat <<USAGE
usage: install-server.sh [--ref vX.Y.Z|latest] [--prefix <dir>]
  --ref     release tag to install (default: latest)
  --prefix  npm prefix for memmem-server and Letta Code
            (default: \${MEMMEM_SERVER_INSTALL_PREFIX:-npm's global prefix})
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) [ $# -ge 2 ] || die "--ref needs a value"; REF="$2"; shift 2 ;;
    --ref=*) REF="${1#--ref=}"; shift ;;
    --prefix) [ $# -ge 2 ] || die "--prefix needs a value"; PREFIX="$2"; shift 2 ;;
    --prefix=*) PREFIX="${1#--prefix=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

case "$REF" in
  latest|v[0-9]*) ;;
  *) die "--ref must be latest or a tag like v0.2.0 (got: $REF)" ;;
esac

case "$(uname -s)" in
  Linux|Darwin) ;;
  *) die "unsupported OS: $(uname -s) (use the Docker image, or WSL on Windows)" ;;
esac

# ver_ge A B: true when version A >= version B (numeric x.y.z, suffixes ignored).
ver_ge() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    na = split(a, x, /[.]/); nb = split(b, y, /[.]/)
    for (i = 1; i <= 3; i++) { p = x[i] + 0; q = y[i] + 0; if (p > q) exit 0; if (p < q) exit 1 }
    exit 0 }'
}
# First x.y.z in a string ("0.34.41 (Letta Code)" -> 0.34.41, "v24.22.2" -> 24.22.2).
ver_of() { printf '%s\n' "$1" | sed -n 's/^[^0-9]*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -n 1; }

# ---- prerequisites (reported, never installed) ----
if ! command -v node >/dev/null 2>&1; then
  die "Node.js >= 24.22 is required (Letta Code's minimum) and was not found.
  Install it from https://nodejs.org or with a version manager, for example:
    mise use -g node@24      or      nvm install 24
  then run this script again."
fi
node_v=$(ver_of "$(node --version 2>/dev/null || true)")
if [ -z "$node_v" ] || ! ver_ge "$node_v" "$NODE_MIN"; then
  die "Node.js >= 24.22 is required (Letta Code's minimum); found ${node_v:-an unknown version} at $(command -v node).
  Upgrade it from https://nodejs.org or with a version manager, for example:
    mise use -g node@24      or      nvm install 24
  then run this script again."
fi
command -v npm >/dev/null 2>&1 || die "npm was not found next to Node.js $node_v (it ships with Node; reinstall Node or put npm on PATH)"
command -v git >/dev/null 2>&1 || die "git is required (MemFS and the memory/transcripts repos); install it with your package manager"
command -v gh >/dev/null 2>&1 || warn "gh not found (optional: creates repos and handles git auth for GitHub; https://cli.github.com)"
command -v zstd >/dev/null 2>&1 || warn "zstd not found (optional: compressed Codex sessions)"
say "node $node_v, $(git --version)"

# ---- install location ----
if [ -n "$PREFIX" ]; then
  mkdir -p "$PREFIX" || die "could not create $PREFIX"
  PREFIX=$(cd "$PREFIX" && pwd)
  set -- --prefix "$PREFIX"
else
  PREFIX=$(npm prefix -g 2>/dev/null) || die "could not read npm's global prefix (npm prefix -g)"
  set --
fi
BIN_DIR="$PREFIX/bin"
# npm -g writes to <prefix>/lib/node_modules and <prefix>/bin. Never sudo: a
# root-owned prefix (a system Node) gets a hint instead.
for d in "$PREFIX/lib/node_modules" "$PREFIX/lib" "$PREFIX"; do
  if [ -d "$d" ]; then
    [ -w "$d" ] || die "$d is not writable. Do not use sudo; install into a prefix you own instead:
    curl -fsSL .../install-server.sh | sh -s -- --prefix \$HOME/.local
  (or MEMMEM_SERVER_INSTALL_PREFIX=\$HOME/.local, or a Node version manager such as mise or nvm)"
    break
  fi
done

# ---- download helpers ----
if command -v curl >/dev/null 2>&1; then DL=curl
elif command -v wget >/dev/null 2>&1; then DL=wget
else die "need curl or wget"; fi

# fetch <url> <out-file>: GITHUB_TOKEN goes only to api.github.com (release
# downloads redirect to another host, which must not receive it).
fetch() {
  url=$1; out=$2
  auth=""
  case "$url" in
    https://api.github.com/*) if [ -n "${GITHUB_TOKEN:-}" ]; then auth="Authorization: Bearer $GITHUB_TOKEN"; fi ;;
  esac
  if [ "$DL" = curl ]; then
    if [ -n "$auth" ]; then curl -fsSL --retry 3 -H "$auth" -o "$out" "$url"; else curl -fsSL --retry 3 -o "$out" "$url"; fi
  else
    if [ -n "$auth" ]; then wget -q --tries=3 --header="$auth" -O "$out" "$url"; else wget -q --tries=3 -O "$out" "$url"; fi
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | awk '{print $NF}'
  else die "need sha256sum, shasum, or openssl to verify the download"; fi
}

TMP=$(mktemp -d 2>/dev/null || mktemp -d -t memmem-server)
LOCK="$PREFIX/.memmem-server-install.lock"
LOCKED=""
cleanup() {
  rm -rf "$TMP"
  if [ -n "$LOCKED" ]; then rmdir "$LOCK" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ---- resolve the tag ----
if [ "$REF" = latest ]; then
  TAG=""
  if fetch "https://api.github.com/repos/$OWNER/$REPO/releases/latest" "$TMP/latest.json" 2>/dev/null; then
    TAG=$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TMP/latest.json" | head -n 1)
  fi
  [ -n "$TAG" ] || die "could not resolve the latest release of $OWNER/$REPO (set GITHUB_TOKEN if rate limited, or pass --ref vX.Y.Z)"
  case "$TAG" in v[0-9]*) ;; *) die "unexpected latest release tag: $TAG" ;; esac
else
  TAG=$REF
fi
VERSION=${TAG#v}
ASSET="memmem-server-$VERSION.tgz"
BASE="https://github.com/$OWNER/$REPO/releases/download/$TAG"
say "installing memmem-server $TAG into $PREFIX"

# ---- download and verify (before touching anything) ----
fetch "$BASE/$ASSET" "$TMP/$ASSET" || die "download failed: $BASE/$ASSET (does release $TAG exist?)"
fetch "$BASE/SHA256SUMS" "$TMP/SHA256SUMS" || die "download failed: $BASE/SHA256SUMS"
want=$(awk -v f="$ASSET" '$2 == f || $2 == "*"f {print $1}' "$TMP/SHA256SUMS" | head -n 1)
[ -n "$want" ] || die "$ASSET is not listed in SHA256SUMS"
got=$(sha256_of "$TMP/$ASSET")
[ "$want" = "$got" ] || die "checksum mismatch for $ASSET (expected $want, got $got)"
say "checksum ok"

# ---- install (locked) ----
mkdir "$LOCK" 2>/dev/null || die "another install is running (remove $LOCK if it is stale)"
LOCKED=1

# Letta Code: prefer the copy in the target prefix, else the one on PATH.
letta_bin=""
if [ -x "$BIN_DIR/letta" ]; then letta_bin="$BIN_DIR/letta"
elif command -v letta >/dev/null 2>&1; then letta_bin=$(command -v letta); fi
letta_v=""
if [ -n "$letta_bin" ]; then letta_v=$(ver_of "$("$letta_bin" --version 2>/dev/null || true)"); fi

if [ -n "$letta_v" ] && ver_ge "$letta_v" "$LETTA_CODE_MIN"; then
  if ver_ge "$letta_v" "$LETTA_CODE_BELOW"; then
    warn "Letta Code $letta_v ($letta_bin) is newer than the supported ^$LETTA_CODE_MIN; leaving it as is."
    warn "memmem-server doctor will flag it. To pin the tested version: npm i -g $* --allow-scripts=@letta-ai/letta-code,node-pty @letta-ai/letta-code@$LETTA_CODE_VERSION"
  else
    say "Letta Code $letta_v ok ($letta_bin)"
  fi
else
  if [ -n "$letta_v" ]; then
    say "Letta Code $letta_v is older than $LETTA_CODE_MIN; upgrading it to $LETTA_CODE_VERSION (this replaces the global letta)"
  else
    say "Letta Code not found; installing @letta-ai/letta-code@$LETTA_CODE_VERSION from npm (Letta's own channel)"
  fi
  # npm 11 blocks install scripts by default; Letta Code needs its postinstall
  # and node-pty's native build (python3, make and a C++ compiler).
  npm i -g "$@" --no-audit --no-fund --allow-scripts=@letta-ai/letta-code,node-pty \
    "@letta-ai/letta-code@$LETTA_CODE_VERSION" \
    || die "installing Letta Code failed (node-pty needs python3, make and a C++ compiler)"
  if [ -x "$BIN_DIR/letta" ]; then letta_bin="$BIN_DIR/letta"; else letta_bin=$(command -v letta || true); fi
  letta_v=""
  if [ -n "$letta_bin" ]; then letta_v=$(ver_of "$("$letta_bin" --version 2>/dev/null || true)"); fi
  [ -n "$letta_v" ] || die "Letta Code was installed but 'letta --version' does not run"
  say "Letta Code $letta_v installed ($letta_bin)"
fi

# The tarball bundles its runtime dependencies, so the Agent SDK's peer
# (Letta Code) is not installed a second time inside memmem-server.
npm i -g "$@" --no-audit --no-fund "$TMP/$ASSET" || die "npm i -g $ASSET failed"
[ -x "$BIN_DIR/memmem-server" ] || die "memmem-server was not installed into $BIN_DIR"
if ! got_v=$("$BIN_DIR/memmem-server" version 2>&1); then
  die "the installed memmem-server failed to run: $got_v"
fi
[ "$got_v" = "$VERSION" ] || die "memmem-server version printed '$got_v', expected $VERSION"
say "installed $BIN_DIR/memmem-server (version $got_v)"

# ---- PATH hint (no shell files are edited) ----
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    say "$BIN_DIR is not on your PATH. Add it, for example:"
    case "${SHELL:-}" in
      */zsh) say "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc" ;;
      */fish) say "  fish_add_path $BIN_DIR" ;;
      *) say "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.bashrc   (or ~/.profile)" ;;
    esac
    ;;
esac
say "next: memmem-server setup"
