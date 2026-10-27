# GridCraft Viewer for Obsidian

Open `.xlsx` and `.csv` files from your vault in an Obsidian tab instead of Excel. Workbooks are
read with [GridCraft](https://github.com/Azurehawke/gridcraft)'s spreadsheet engine (compiled to
WebAssembly), so formulas are recalculated and number formats, fonts, fills, borders, merged
cells and hidden rows and columns show as they do in GridCraft.

Read-only: edit workbooks in GridCraft. Open tabs and tables in notes refresh when the file changes.

Works on desktop and mobile Obsidian.

## Sheets inside notes

```markdown
![[Budget.xlsx]]                  the active sheet (first 200 rows)
![[Budget.xlsx#Summary]]          a sheet by name
![[Budget.xlsx#Summary!A1:F20]]   a range on that sheet
![[Budget.xlsx#B2:D9]]            a range on the active sheet
![[Budget.xlsx#'Q1 Sales'!A1:C9]] quote sheet names with ! or ' in them
```

Embeds use an Obsidian feature that isn't part of its public plugin API. If an Obsidian update
breaks them, the code block keeps working:

````markdown
```gridcraft
file: Budget.xlsx
sheet: Summary
range: A1:F20
headers: true
```
````

`file:` also takes a link (`[[Budget.xlsx#Summary!A1:F20]]`); `headers: true` shows column
letters and row numbers. The copy button on each table copies it as a Markdown table (first row
as the header) or as tab-separated text for pasting into a spreadsheet.

## Install (BRAT)

1. Install the **BRAT** community plugin.
2. BRAT › Add beta plugin › `Azurehawke/obsidian-gridcraft`.
3. Enable **GridCraft Viewer** under Community plugins.

The first spreadsheet you open downloads the GridCraft engine (about 1.4 MB) from this repo's
release of the same version. It's checked against a fingerprint built into the plugin and saved
in the plugin folder, so sync (Syncthing, Obsidian Sync) carries it to your other devices. Each
plugin update downloads the matching engine once and removes the old one.

## Roadmap

- **0.1**: `.xlsx` and `.csv` in a read-only tab, sheet tabs, rows load as you scroll.
- **0.2**: sheets inside notes (embeds and the `gridcraft` code block), copy a table as
  Markdown or tab-separated text.

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

Set the new version in `manifest.json`, `package.json` and `versions.json`, commit and push to
`main`. The Release workflow notices a version with no release yet, builds the engine and plugin,
creates the tag (the bare version, no `v`) and publishes `main.js`, `manifest.json`, `styles.css`
and `gridcraft-engine.wasm.gz`. BRAT picks the update up from there.

The engine is pinned to a commit of the GridCraft fork in `engine/Cargo.toml` (`rev = …`). Move
it forward to pick up newer GridCraft code.

## Licence

MIT. GridCraft is MIT OR Apache-2.0.
