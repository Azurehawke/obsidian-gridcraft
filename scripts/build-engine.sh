#!/usr/bin/env bash
# Builds GridCraft's engine for the plugin into engine/pkg/:
#   gridcraft_obsidian_engine.js       wasm-bindgen glue (bundled into main.js)
#   gridcraft_obsidian_engine_bg.wasm  the engine (shipped as gridcraft-engine.wasm.gz)
#
# Needs Rust with the wasm32-unknown-unknown target. Installs the matching wasm-bindgen CLI if
# it's missing. Shrinks the engine with wasm-opt when wasm-opt is on PATH (CI always has it).
set -euo pipefail

cd "$(dirname "$0")/../engine"

cargo build --release --target wasm32-unknown-unknown

# The wasm-bindgen CLI must be the same version as the wasm-bindgen crate in Cargo.lock.
wb_version=$(awk '$0 == "name = \"wasm-bindgen\"" { getline; gsub(/"/, "", $3); print $3; exit }' Cargo.lock)
if [ -z "$wb_version" ]; then
	echo "Couldn't find the wasm-bindgen version in engine/Cargo.lock" >&2
	exit 1
fi
if ! command -v wasm-bindgen >/dev/null 2>&1 || [ "$(wasm-bindgen --version | awk '{print $2}')" != "$wb_version" ]; then
	cargo install wasm-bindgen-cli --version "$wb_version" --locked
fi

rm -rf pkg
wasm-bindgen --target web --out-dir pkg --out-name gridcraft_obsidian_engine \
	target/wasm32-unknown-unknown/release/gridcraft_obsidian_engine.wasm

if command -v wasm-opt >/dev/null 2>&1; then
	wasm-opt -Oz \
		--enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
		--enable-mutable-globals --enable-reference-types --enable-multivalue \
		-o pkg/opt.wasm pkg/gridcraft_obsidian_engine_bg.wasm
	mv -f pkg/opt.wasm pkg/gridcraft_obsidian_engine_bg.wasm
else
	echo "wasm-opt not found: the engine is built but not size-optimised" >&2
fi

ls -l pkg
