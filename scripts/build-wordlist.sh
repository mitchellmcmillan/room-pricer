#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/wordlists/wiki-100k.txt"
OUT="$ROOT/wordlists/english-lowercase.txt"

if [[ ! -f "$SRC" ]]; then
  echo "Missing source word list: $SRC" >&2
  exit 1
fi

mkdir -p "$ROOT/wordlists"

# From wiki-100k, keep only lowercase a-z words, length >=4, in original order, first 5000.
awk '
  /^#/ { next }
  /^[a-z]{4,}$/ { print; count++; if (count >= 1000) exit }
' "$SRC" > "$OUT"

echo "Wrote $(wc -l < "$OUT") words to $OUT from $SRC"
