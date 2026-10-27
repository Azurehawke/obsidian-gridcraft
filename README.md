# GridCraft Viewer for Obsidian

Open `.xlsx` and `.csv` files from your vault in an Obsidian tab instead of Excel. Workbooks are
read with [GridCraft](https://github.com/Azurehawke/gridcraft)'s spreadsheet engine (compiled to
WebAssembly), so formulas are recalculated and number formats, fonts, fills, borders, merged
cells and hidden rows and columns show as they do in GridCraft.

Version 0.1 is **read-only**. Edit workbooks in GridCraft; an open tab refreshes when the file
changes.

Works on desktop and mobile Obsidian.

## Install (BRAT)

1. Install the **BRAT** community plugin.
2. BRAT › Add beta plugin › `Azurehawke/obsidian-gridcraft`.
3. Enable **GridCraft Viewer** under Community plugins.

The first spreadsheet you open downloads the GridCraft engine (about 3 MB) from this repo's
release of the same version. It's checked against a fingerprint built into the plugin and saved
in the plugin folder, so sync (Syncthing, Obsidian Sync) carries it to your other devices. Each
plugin update downloads the matching engine once and removes the old one.

## Roadmap

- **0.1**: `.xlsx` and `.csv` in a read-only tab, sheet tabs, rows load as you scroll.
- **0.2**: sheets inside notes, `![[Budget.xlsx#Sheet1!A1:D20]]` embeds with a code-block
  fallback, and copying a table as Markdown or tab-separated text.

## Building

Needs Rust (with `rustup target add wasm32-unknown-unknown`) and Node.js.

```bash
npm run engine      # builds engine/pkg/ (installs the matching wasm-bindgen CLI if needed)
npm install
npm run build       # main.js, fingerprinting the engine in engine/pkg/
```

For a test install without a release, copy `main.js`, `manifest.json` and `styles.css` to
`<vault>/.obsidian/plugins/gridcraft-viewer/`, and the engine there as `engine-<version>.wasm`:

```bash
cp engine/pkg/gridcraft_obsidian_engine_bg.wasm "<vault>/.obsidian/plugins/gridcraft-viewer/engine-$(node -p "require('./manifest.json').version").wasm"
```

Every push to `main` builds that folder in GitHub Actions too (the `gridcraft-viewer` artifact
of the CI run).

`npm run dev` makes a development build that loads `engine.wasm` from the plugin folder without
a fingerprint check, and rebuilds on every change.

## Releasing

Set the version in `manifest.json`, `package.json` and `versions.json`, commit, then tag it
without a `v`:

```bash
git tag 0.1.0 && git push origin 0.1.0
```

The Release workflow builds the engine and plugin and publishes `main.js`, `manifest.json`,
`styles.css` and `gridcraft-engine.wasm.gz`.

The engine is pinned to a commit of the GridCraft fork in `engine/Cargo.toml` (`rev = …`). Move
it forward to pick up newer GridCraft code.

## Licence

MIT. GridCraft is MIT OR Apache-2.0.
