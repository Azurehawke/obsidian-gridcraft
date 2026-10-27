# GridCraft Viewer for Obsidian

Open and edit `.xlsx` and `.csv` files from your vault in an Obsidian tab instead of Excel, and show sheets inside notes. Workbooks are
read with [GridCraft](https://github.com/Azurehawke/gridcraft)'s spreadsheet engine (compiled to
WebAssembly), so formulas are recalculated and number formats, fonts, fills, borders, merged
cells and hidden rows and columns show as they do in GridCraft.

## Editing in the tab

Click a cell to select it and type to replace it, or double-click (or F2) to edit what's there;
the formula bar above the grid edits the selected cell too. Values, text, dates and `=formulas`
are entered as in GridCraft and the sheet recalculates.

| Keys | |
| --- | --- |
| Arrows, Enter, Tab (Shift to go back) | move |
| Enter / Tab while editing | enter and move on |
| Esc | cancel the edit |
| Delete, Backspace | clear the cell |
| Ctrl+Z, Ctrl+Y (Cmd on a Mac) | undo, redo |
| Shift+arrows, Shift+click, drag | select a range |
| Ctrl+B, Ctrl+I, Ctrl+U | bold, italic, underline |
| Ctrl+C, Ctrl+V | copy the selected cells; paste text (tab-separated lines fill a block) |
| Ctrl+S | save now |

### Formatting

The toolbar under the formula bar formats the selected cells with GridCraft's own commands:
bold, italic, underline, strikethrough, font size, font and fill colours (theme colours with
shades, standard colours, or any colour), borders, alignment, wrap, merge & centre, number
formats ($, %, decimals, dates), AutoFit column width and Clear formats. **Format as Table**
applies one of 60 table styles (light, medium, dark) with banded rows; inside a table the same
button changes its style and sets total row, banded rows and columns, first and last column.
The palette button in the bar hides or shows the toolbar.

Tables, conditional formats (fills, colour scales, data bars, icon sets) and cell colours show
in the tab and in notes. In dark themes, text on a coloured fill switches to black or white so
it stays readable.

The file is saved a moment after each change ("Saved" in the corner) and when the tab closes.
Saving rewrites the file with GridCraft's writer, as saving in GridCraft does. A `.csv` keeps
values only, so a formula's result is saved rather than the formula. Tables inside notes stay
read-only and refresh after a save; if the file changes on disk (sync, GridCraft), open tabs
reload it.

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

The first spreadsheet you open downloads the GridCraft engine (about 2.8 MB) from this repo's
release of the same version. It's checked against a fingerprint built into the plugin and saved
in the plugin folder, so sync (Syncthing, Obsidian Sync) carries it to your other devices. Each
plugin update downloads the matching engine once and removes the old one.

## Roadmap

- **0.1**: `.xlsx` and `.csv` in a read-only tab, sheet tabs, rows load as you scroll.
- **0.2**: sheets inside notes (embeds and the `gridcraft` code block), copy a table as
  Markdown or tab-separated text.
- **0.3**: edit cells in the tab (formula bar, undo/redo, paste), saved automatically.
- **0.4**: formatting toolbar, Format as Table, range selection; table styles and conditional
  formats drawn in tabs and notes.

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
