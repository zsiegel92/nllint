#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
skill_dir="${1:-${CODEX_HOME:-$HOME/.codex}/skills}/nllint"
mkdir -p "$skill_dir"
install -m 644 "$root/skills/nllint/SKILL.md" "$skill_dir/SKILL.md"
printf 'Installed NLLint skill to %s\n' "$skill_dir"
