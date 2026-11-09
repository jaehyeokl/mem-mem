#!/bin/sh
# Install the memmem client binary from GitHub Releases.
#
#   curl -fsSL https://raw.githubusercontent.com/jaehyeokl/mem-mem/main/scripts/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --ref v0.2.0
#
# What it does: detects OS/arch (linux|darwin, x64|arm64), downloads
# memmem-<os>-<arch> and SHA256SUMS from the release, verifies the checksum,
# installs to ${MEMMEM_INSTALL_DIR:-$HOME/.local/bin}/memmem (backing up and
# restoring an existing binary if the new one fails `memmem --version`), and
# prints a PATH hint. It never edits shell startup files.
#
# Environment: MEMMEM_INSTALL_DIR (install directory), GITHUB_TOKEN (optional;
# sent only to api.github.com, whose anonymous rate limit `latest` uses),
# MEMMEM_OWNER (release repository owner, see OWNER below).
set -eu

# Release repository. Change OWNER when the repository moves to an organization.
OWNER="${MEMMEM_OWNER:-jaehyeokl}"
REPO="mem-mem"
REF="latest"
INSTALL_DIR="${MEMMEM_INSTALL_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "memmem-install: $*"; }
die() { printf '%s\n' "memmem-install: error: $*" >&2; exit 1; }

usage() {
  cat <<USAGE
usage: install.sh [--ref vX.Y.Z|latest] [--dir <install dir>]
  --ref   release tag to install (default: latest)
  --dir   install directory (default: \${MEMMEM_INSTALL_DIR:-\$HOME/.local/bin})
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) [ $# -ge 2 ] || die "--ref needs a value"; REF="$2"; shift 2 ;;
    --ref=*) REF="${1#--ref=}"; shift ;;
    --dir) [ $# -ge 2 ] || die "--dir needs a value"; INSTALL_DIR="$2"; shift 2 ;;
    --dir=*) INSTALL_DIR="${1#--dir=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

case "$REF" in
  latest|v[0-9]*) ;;
  *) die "--ref must be latest or a tag like v0.2.0 (got: $REF)" ;;
esac

# ---- platform ----
os=$(uname -s)
case "$os" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  MINGW*|MSYS*|CYGWIN*) die "on Windows use scripts/install.ps1 (PowerShell)" ;;
  *) die "unsupported OS: $os" ;;
esac
arch=$(uname -m)
case "$arch" in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) die "unsupported architecture: $arch" ;;
esac
# A shell running under Rosetta reports x86_64; prefer the native binary.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi
ASSET="memmem-$os-$arch"

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

TMP=$(mktemp -d 2>/dev/null || mktemp -d -t memmem)
LOCK="$INSTALL_DIR/.memmem-install.lock"
DEST="$INSTALL_DIR/memmem"
BACKUP=""
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
else
  TAG=$REF
fi
BASE="https://github.com/$OWNER/$REPO/releases/download/$TAG"
say "installing memmem $TAG ($ASSET) into $INSTALL_DIR"

# ---- download and verify ----
fetch "$BASE/$ASSET" "$TMP/$ASSET" || die "download failed: $BASE/$ASSET"
fetch "$BASE/SHA256SUMS" "$TMP/SHA256SUMS" || die "download failed: $BASE/SHA256SUMS"
want=$(awk -v f="$ASSET" '$2 == f || $2 == "*"f {print $1}' "$TMP/SHA256SUMS" | head -n 1)
[ -n "$want" ] || die "$ASSET is not listed in SHA256SUMS"
got=$(sha256_of "$TMP/$ASSET")
[ "$want" = "$got" ] || die "checksum mismatch for $ASSET (expected $want, got $got)"
say "checksum ok"
chmod 0755 "$TMP/$ASSET"

# ---- install (locked, with backup/restore) ----
mkdir -p "$INSTALL_DIR"
mkdir "$LOCK" 2>/dev/null || die "another install is running (remove $LOCK if it is stale)"
LOCKED=1
if [ -e "$DEST" ]; then
  BACKUP="$DEST.bak.$$"
  cp -p "$DEST" "$BACKUP"
fi
restore() {
  if [ -n "$BACKUP" ] && [ -e "$BACKUP" ]; then
    mv -f "$BACKUP" "$DEST"
    say "restored the previous memmem"
  else
    rm -f "$DEST"
  fi
}
if ! { cp "$TMP/$ASSET" "$DEST.new.$$" && mv -f "$DEST.new.$$" "$DEST"; }; then
  rm -f "$DEST.new.$$"
  restore
  die "could not write $DEST"
fi
if ! version=$("$DEST" --version 2>&1); then
  restore
  die "the new binary failed to run: $version"
fi
if [ -n "$BACKUP" ]; then rm -f "$BACKUP"; fi
say "installed $DEST (version $version)"

# ---- PATH hint (no shell files are edited) ----
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    say "$INSTALL_DIR is not on your PATH. Add it, for example:"
    case "${SHELL:-}" in
      */zsh) say "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.zshrc" ;;
      */fish) say "  fish_add_path $INSTALL_DIR" ;;
      *) say "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.bashrc   (or ~/.profile)" ;;
    esac
    say "Desktop apps that run hooks may need a restart to see it; 'memmem setup' also writes an absolute-path safety net for Claude Code."
    ;;
esac
say "next: in your project run 'memmem setup' (first member) or 'memmem setup --member <name>' (teammates)"
