#!/bin/sh
# Installs the wgw command line from app.wgw.lol into ~/.local/bin (or $WGW_INSTALL_DIR).
set -eu
dir="${WGW_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$dir"
curl -fsSL https://app.wgw.lol/wgw.mjs -o "$dir/wgw"
if ! command -v node >/dev/null 2>&1; then
  if command -v bun >/dev/null 2>&1; then
    sed -i.bak '1s|.*|#!/usr/bin/env bun|' "$dir/wgw" && rm -f "$dir/wgw.bak"
  else
    echo "wgw needs Node.js 20+ or Bun." >&2
    exit 1
  fi
fi
chmod +x "$dir/wgw"
echo "Installed $dir/wgw. Next: wgw login"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "Add $dir to your PATH." ;;
esac
