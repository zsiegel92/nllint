#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
install_dir="${NLLINT_INSTALL_DIR:-$HOME/.local/bin}"
schema_dir="$(dirname "$install_dir")/share/nllint"

build_dir="${CARGO_TARGET_DIR:-$root/target}"
cd "$root"
cargo build --locked --release -p nllint
mkdir -p "$install_dir"
temporary=$(mktemp "$install_dir/.nllint.XXXXXX")
trap 'rm -f "$temporary"' EXIT
install -m 755 "$build_dir/release/nllint" "$temporary"
mv -f "$temporary" "$install_dir/nllint"
trap - EXIT
mkdir -p "$schema_dir"
install -m 644 "$root/schema/nllint.schema.json" "$schema_dir/nllint.schema.json"
install -m 644 "$root/schema/credentials.schema.json" "$schema_dir/credentials.schema.json"
printf 'Installed NLLint to %s/nllint\n' "$install_dir"
