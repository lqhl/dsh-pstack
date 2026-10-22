#!/usr/bin/env bash
# Link the vendored pstack into DSH, render the adapter, and upsert the AGENTS.md block.
# Idempotent: safe to re-run after `git pull` or `make sync`.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
VENDOR="$REPO/vendor/pstack"
SKILLS="$VENDOR/skills"
BEGIN='<!-- pstack:begin -->'
END='<!-- pstack:end -->'

[ -d "$SKILLS" ] || { echo "missing $SKILLS; run make sync" >&2; exit 1; }
mkdir -p "$DSH_HOME/skills" "$DSH_HOME/adapter"

# 1. One stable path for every generated reference.
ln -sfn "$VENDOR" "$DSH_HOME/pstack"

# 2. One relative symlink per skill, so moving the repo or the home dir keeps them working.
linked=0
for dir in "$SKILLS"/*/; do
  name="$(basename "$dir")"
  [ -f "$dir/SKILL.md" ] || continue
  ln -sfn "../pstack/skills/$name" "$DSH_HOME/skills/$name"
  linked=$((linked + 1))
done

# 3. Drop links whose upstream skill disappeared, leaving every non-pstack entry alone.
pruned=0
for link in "$DSH_HOME/skills"/*; do
  [ -L "$link" ] || continue
  case "$(readlink "$link")" in
    ../pstack/skills/*) [ -e "$link" ] || { rm -f "$link"; pruned=$((pruned + 1)); } ;;
  esac
done

# 4. Render the adapter from its template.
sed "s|{{DSH_HOME}}|$DSH_HOME|g" "$REPO/adapter/dsh.md.in" > "$DSH_HOME/adapter/dsh.md"

# 5. Upsert the AGENTS.md block, preserving everything outside the markers.
AGENTS="$DSH_HOME/AGENTS.md"
FRAGMENT="$(mktemp)"
trap 'rm -f "$FRAGMENT"' EXIT
sed "s|{{DSH_HOME}}|$DSH_HOME|g" "$REPO/agents-fragment.md.in" > "$FRAGMENT"
if [ ! -f "$AGENTS" ]; then
  printf '# AGENTS.md\n\n' > "$AGENTS"
fi
if grep -qF "$BEGIN" "$AGENTS"; then
  awk -v begin="$BEGIN" -v end="$END" -v frag="$FRAGMENT" '
    BEGIN { while ((getline line < frag) > 0) block = block line "\n" }
    $0 == begin { printf "%s", block; skipping = 1; next }
    $0 == end   { skipping = 0; next }
    !skipping   { print }
  ' "$AGENTS" > "$AGENTS.tmp"
  mv "$AGENTS.tmp" "$AGENTS"
else
  { printf '\n'; cat "$FRAGMENT"; } >> "$AGENTS"
fi

echo "linked $linked skills into $DSH_HOME/skills (pruned $pruned)"
echo "adapter   $DSH_HOME/adapter/dsh.md"
echo "agents    $AGENTS"
echo
echo "preset: install once per profile with the DSH plugin_manager,"
echo "        target = $REPO/preset"
