//! GridCraft's engine for the GridCraft Viewer Obsidian plugin.
//!
//! The plugin hands over a file's bytes ([`Book::open`]), asks which sheets it holds
//! ([`Book::info`]) and asks for a block of cells as JSON ([`Book::render`]), which it turns
//! into an HTML table. The tab view edits through GridCraft's own commands ([`Book::set_cell`],
//! undo and redo) and gets the file's new bytes from [`Book::save`]; the plugin writes them.
//!
//! Input is hostile (any file in the vault): no panics, sizes are capped, and every lookup
//! that can miss returns an error the plugin shows in place of the table.
#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unimplemented, clippy::todo, clippy::unreachable)]

use std::collections::{HashMap, HashSet};

use gridcraft_engine::core::{CellRef, RangeRef, Value, col_to_letters};
use gridcraft_engine::cf::{CfCache, CfLook};
use gridcraft_engine::{DocState, Session, Trust};
use gridcraft_engine::model::{BorderLine, BorderStyle, Color, HAlign, PatternType, Sheet, Style, Theme, Underline, VAlign, Visibility, Workbook};
use serde_json::{Map, Value as Json, json};
use wasm_bindgen::prelude::*;

/// Most rows one [`Book::render`] call returns; the plugin asks for more as you scroll.
const ROW_LIMIT: u32 = 5_000;
/// Most columns one call returns.
const COL_LIMIT: u32 = 500;
/// Most cells one call returns, whatever the row and column counts.
const CELL_LIMIT: u32 = 250_000;

/// The engine wrapper's version (the plugin checks it matches its own build).
#[wasm_bindgen(js_name = engineVersion)]
pub fn engine_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// One opened workbook (or CSV file), recalculated as GridCraft does on open, in a GridCraft
/// session so edits get its undo history and recalculation.
#[wasm_bindgen]
pub struct Book {
    session: Session,
    warnings: Vec<String>,
}

fn js(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

impl Book {
    fn wb(&self) -> Result<&Workbook, JsError> {
        Ok(&*self.session.doc().map_err(js)?.wb)
    }
}

#[wasm_bindgen]
impl Book {
    /// Opens a file's bytes. `name` (with its extension) decides the format when the bytes
    /// don't: `.xlsx`, `.xlsm`, `.xls`, `.xlsb`, `.ods`, `.csv`, `.tsv`.
    pub fn open(name: &str, bytes: &[u8]) -> Result<Book, JsError> {
        let (wb, warnings) = gridcraft_engine::io::open_bytes(name, bytes).map_err(js)?;
        let mut session = Session::new();
        session.add_document(DocState::new(wb, Some(name.to_string()), name.to_string(), Trust::FromFile));
        Ok(Book { session, warnings })
    }

    /// JSON: `{ sheets: [{ name, hidden, used, lastRow, lastCol }], active, warnings }`.
    /// `used` is the used range in A1 notation (`null` for an empty sheet); `lastRow` and
    /// `lastCol` are 0-based.
    pub fn info(&self) -> String {
        let Ok(wb) = self.wb() else { return json!({ "sheets": [], "active": 0, "warnings": self.warnings }).to_string() };
        let sheets: Vec<Json> = wb
            .sheets
            .iter()
            .map(|sh| {
                let used = sh.used_range();
                json!({
                    "name": sh.name,
                    "hidden": sh.visibility != Visibility::Visible,
                    "used": used.map(|r| r.to_string()),
                    "lastRow": used.map(|r| r.end.row),
                    "lastCol": used.map(|r| r.end.col),
                })
            })
            .collect();
        json!({ "sheets": sheets, "active": wb.active_sheet, "warnings": self.warnings }).to_string()
    }

    /// What editing a cell starts from: its formula (`=SUM(A1:A9)`), or its value as typed.
    #[wasm_bindgen(js_name = editText)]
    pub fn edit_text(&self, sheet: usize, cell: &str) -> Result<String, JsError> {
        let wb = self.wb()?;
        let sh = wb.sheet(sheet).ok_or_else(|| JsError::new("This sheet doesn't exist."))?;
        let c = CellRef::parse(cell).ok_or_else(|| JsError::new(&format!("'{cell}' isn't a cell.")))?;
        Ok(gridcraft_engine::display::edit_text(wb, sh, c))
    }

    /// Enters `input` in a cell as if typed: a number, text, date, `TRUE`, or a `=formula`.
    /// Empty input clears the cell. Recalculates, and records one undo step.
    #[wasm_bindgen(js_name = setCell)]
    pub fn set_cell(&mut self, sheet: usize, cell: &str, input: &str) -> Result<(), JsError> {
        self.session.execute("cell.set", json!({ "sheet": sheet, "cell": cell, "input": input })).map_err(js)?;
        Ok(())
    }

    /// Undoes the last edit; false when there was nothing to undo.
    pub fn undo(&mut self) -> Result<bool, JsError> {
        if !self.can_undo() {
            return Ok(false);
        }
        self.session.execute("edit.undo", json!({})).map_err(js)?;
        Ok(true)
    }

    /// Redoes the last undone edit; false when there was nothing to redo.
    pub fn redo(&mut self) -> Result<bool, JsError> {
        if !self.can_redo() {
            return Ok(false);
        }
        self.session.execute("edit.redo", json!({})).map_err(js)?;
        Ok(true)
    }

    #[wasm_bindgen(js_name = canUndo)]
    pub fn can_undo(&self) -> bool {
        self.session.doc().is_ok_and(|d| !d.undo.is_empty())
    }

    #[wasm_bindgen(js_name = canRedo)]
    pub fn can_redo(&self) -> bool {
        self.session.doc().is_ok_and(|d| !d.redo.is_empty())
    }

    /// Whether there are edits since opening or the last [`Book::save`].
    #[wasm_bindgen(js_name = isDirty)]
    pub fn is_dirty(&self) -> bool {
        self.session.doc().is_ok_and(DocState::is_dirty)
    }

    /// The workbook encoded for `name`'s extension (`.xlsx`, `.csv`, ...), as GridCraft saves
    /// it. The book then counts as saved. A CSV keeps values only, as in GridCraft.
    pub fn save(&mut self, name: &str) -> Result<Vec<u8>, JsError> {
        let bytes = gridcraft_engine::io::save_bytes(self.wb()?, name).map_err(js)?;
        let d = self.session.doc_mut().map_err(js)?;
        d.saved = d.wb.clone();
        Ok(bytes)
    }

    /// The sheet's index by name (case-insensitive), or -1.
    #[wasm_bindgen(js_name = sheetIndex)]
    pub fn sheet_index(&self, name: &str) -> i32 {
        let want = name.trim().to_lowercase();
        let Ok(wb) = self.wb() else { return -1 };
        wb.sheets.iter().position(|sh| sh.name.to_lowercase() == want).and_then(|i| i32::try_from(i).ok()).unwrap_or(-1)
    }

    /// Runs a GridCraft command (`home.bold`, `home.fillColor`, `home.formatAsTable`, ...) on
    /// `sheet` with JSON params, as the ribbon would; records one undo step. Returns its result
    /// as JSON. `sheet` is added to the params, and becomes the active sheet first (some
    /// commands act on the active sheet).
    pub fn run(&mut self, sheet: usize, id: &str, params_json: &str) -> Result<String, JsError> {
        let mut params: Json = if params_json.trim().is_empty() { json!({}) } else { serde_json::from_str(params_json).map_err(js)? };
        let Some(obj) = params.as_object_mut() else { return Err(JsError::new("Command parameters must be a JSON object.")) };
        obj.entry("sheet").or_insert(json!(sheet));
        if self.wb()?.active_sheet != sheet {
            self.session.execute("sheet.activate", json!({ "sheet": sheet })).map_err(js)?;
        }
        let out = self.session.execute(id, params).map_err(js)?;
        Ok(out.to_string())
    }

    /// The format of one cell, for the toolbar's toggle buttons. JSON:
    /// `{ bold, italic, underline, strike, wrap, h, v, numFmt, size, font, fontColor, fill,
    ///    merged, table: { name, style, header, totals, banded, ... } | null }`.
    #[wasm_bindgen(js_name = cellFormat)]
    pub fn cell_format(&self, sheet: usize, cell: &str) -> Result<String, JsError> {
        let wb = self.wb()?;
        let sh = wb.sheet(sheet).ok_or_else(|| JsError::new("This sheet doesn't exist."))?;
        let c = CellRef::parse(cell).ok_or_else(|| JsError::new(&format!("'{cell}' isn't a cell.")))?;
        let st = wb.styles.get(sh.style_id(c));
        let hex = |col: Color| col.resolve(&wb.theme).map(hex3);
        let table = sh.table_at(c).map(|t| {
            json!({ "name": t.name, "style": t.style, "header": t.header_row, "totals": t.totals_row,
                    "banded": t.banded_rows, "bandedCols": t.banded_cols, "firstCol": t.first_col, "lastCol": t.last_col })
        });
        Ok(json!({
            "bold": st.font.bold,
            "italic": st.font.italic,
            "underline": st.font.underline != Underline::None,
            "strike": st.font.strike,
            "wrap": st.align.wrap,
            "h": format!("{:?}", st.align.h),
            "v": format!("{:?}", st.align.v),
            "numFmt": st.num_fmt.as_str(),
            "size": st.font.size,
            "font": st.font.name,
            "fontColor": hex(st.font.color),
            "fill": if st.fill.pattern == PatternType::None { None } else { hex(st.fill.fg) },
            "merged": sh.merge_at(c).is_some(),
            "table": table,
        })
        .to_string())
    }

    /// The colour picker's swatches. JSON: `{ theme: [[{ theme, tint, hex }, ...6 shades] x10],
    /// standard: ["#C00000", ...] }`: the workbook's theme colours (Background 1, Text 1,
    /// Background 2, Text 2, Accent 1-6) with their lighter and darker shades.
    pub fn palette(&self) -> String {
        let theme = self.wb().map(|wb| wb.theme.clone()).unwrap_or_default();
        let columns: Vec<Json> = (0u8..10)
            .map(|slot| {
                let tints: &[f64] = match slot {
                    0 => &[0.0, -0.05, -0.15, -0.25, -0.35, -0.5],
                    1 | 3 => &[0.0, 0.5, 0.35, 0.25, 0.15, 0.05],
                    _ => &[0.0, 0.8, 0.6, 0.4, -0.25, -0.5],
                };
                let shades: Vec<Json> = tints
                    .iter()
                    .map(|&t| {
                        // Tints are kept in thousandths, as the workbook stores them.
                        let thousandths = (t * 1000.0).round() as i16;
                        let hex = Color::Theme(slot, thousandths).resolve(&theme).map(hex3);
                        json!({ "theme": slot, "tint": t, "hex": hex })
                    })
                    .collect();
                Json::Array(shades)
            })
            .collect();
        let standard = ["#C00000", "#FF0000", "#FFC000", "#FFFF00", "#92D050", "#00B050", "#00B0F0", "#0070C0", "#002060", "#7030A0"];
        json!({ "theme": columns, "standard": standard }).to_string()
    }

    /// The Format as Table gallery: `[{ name, family, header, headerFont, band, body, line }]`
    /// with each style's colours in this workbook's theme.
    #[wasm_bindgen(js_name = tableStyles)]
    pub fn table_styles(&self) -> String {
        let theme = self.wb().map(|wb| wb.theme.clone()).unwrap_or_default();
        let hex = |c: Option<Color>| c.and_then(|c| c.resolve(&theme)).map(hex3);
        let list: Vec<Json> = gridcraft_engine::tables::gallery()
            .into_iter()
            .map(|name| {
                let lk = gridcraft_engine::tables::look(&name);
                let (family, _) = gridcraft_engine::tables::parse_style_name(&name);
                json!({ "name": name, "family": family, "header": hex(lk.header_fill), "headerFont": hex(Some(lk.header_font)),
                        "band": hex(lk.band_fill), "body": hex(lk.body_fill), "line": hex(lk.line) })
            })
            .collect();
        Json::Array(list).to_string()
    }

    /// A block of cells as JSON, for the plugin's table.
    ///
    /// `range` is A1 notation (`B2:F40`, `A:D`, `3:9`, `C5`); empty means from A1 to the end
    /// of the used range. Hidden rows and columns are left out. At most `max_rows` rows and
    /// `max_cols` columns come back (0 = the built-in limits); `nextRow` (0-based) says where
    /// to continue when rows were cut off.
    ///
    /// ```text
    /// { sheet, name, range, nextRow, moreCols,
    ///   cols: [{ i, l, w }],                  // index, letters, width in px
    ///   rows: [{ i, h, c: [cell, ...] }],      // index, height in px, one entry per column
    ///   styles: ["css", ...] }
    /// cell: null (empty) | { m: 1 } (inside a merge) |
    ///       { t, s?, a?, fc?, cs?, rs? }       // text, style index, General alignment
    ///                                          // (r|c), number-format colour, col/row span
    /// ```
    pub fn render(&self, sheet: usize, range: &str, max_rows: u32, max_cols: u32) -> Result<String, JsError> {
        let wb = self.wb()?;
        let sh = wb.sheet(sheet).ok_or_else(|| JsError::new("This sheet doesn't exist."))?;
        let r = if range.trim().is_empty() {
            let end = sh.used_range().map(|u| u.end).unwrap_or(CellRef::new(0, 0));
            RangeRef::new(CellRef::new(0, 0), end)
        } else {
            RangeRef::parse(range).ok_or_else(|| JsError::new(&format!("'{range}' isn't a cell range (for example A1:D20).")))?
        };

        let max_cols = if max_cols == 0 { COL_LIMIT } else { max_cols.min(COL_LIMIT) };
        let (vis_cols, more_cols) = visible(r.start.col, r.end.col, max_cols, |c| sh.is_col_hidden(c));
        let per_cells = CELL_LIMIT / u32::try_from(vis_cols.len().max(1)).unwrap_or(u32::MAX).max(1);
        let max_rows = if max_rows == 0 { ROW_LIMIT } else { max_rows.min(ROW_LIMIT) }.min(per_cells.max(1));
        let (vis_rows, more_rows) = visible(r.start.row, r.end.row, max_rows, |row| sh.is_row_hidden(row));
        let next_row = if more_rows { vis_rows.last().map(|x| x.saturating_add(1)) } else { None };

        // Merges: the first visible cell of each merge carries its spans and the merge's
        // top-left content; the other visible cells of the merge are skipped.
        let mut anchors: HashMap<(u32, u32), (CellRef, usize, usize)> = HashMap::new();
        let mut covered: HashSet<(u32, u32)> = HashSet::new();
        for m in &sh.merges {
            let rows: Vec<u32> = vis_rows.iter().copied().filter(|x| *x >= m.start.row && *x <= m.end.row).collect();
            let cols: Vec<u32> = vis_cols.iter().copied().filter(|x| *x >= m.start.col && *x <= m.end.col).collect();
            let (Some(&r0), Some(&c0)) = (rows.first(), cols.first()) else { continue };
            anchors.insert((r0, c0), (m.start, rows.len(), cols.len()));
            for &rr in &rows {
                for &cc in &cols {
                    if (rr, cc) != (r0, c0) {
                        covered.insert((rr, cc));
                    }
                }
            }
        }

        let theme = &wb.theme;
        let mut cf = if sh.cond_formats.is_empty() { None } else { Some(CfCache::new()) };
        let mut style_index: HashMap<String, usize> = HashMap::new();
        let mut styles: Vec<String> = Vec::new();
        let mut rows_out: Vec<Json> = Vec::with_capacity(vis_rows.len());
        for &row in &vis_rows {
            let mut cells: Vec<Json> = Vec::with_capacity(vis_cols.len());
            for &col in &vis_cols {
                if covered.contains(&(row, col)) {
                    cells.push(json!({ "m": 1 }));
                    continue;
                }
                let span = anchors.get(&(row, col)).copied();
                let src = span.map(|(c, _, _)| c).unwrap_or(CellRef::new(row, col));
                let look = cell_look(wb, sheet, sh, src, &mut cf);
                let style = &look.style;
                let value = sh.value(src);
                let mut cell = Map::new();
                let hide = look.cf.as_ref().is_some_and(|l| l.hide_value);
                if !matches!(value, Value::Empty) {
                    let f = gridcraft_engine::display::format(&value, style.num_fmt.as_str(), wb);
                    if !hide {
                        cell.insert("t".into(), Json::from(f.text));
                    }
                    if style.align.h == HAlign::General {
                        let a = match value {
                            Value::Bool(_) | Value::Error(_) => Some("c"),
                            _ if f.numeric => Some("r"),
                            _ => None,
                        };
                        if let Some(a) = a {
                            cell.insert("a".into(), Json::from(a));
                        }
                    }
                    if let Some([r, g, b]) = f.color.and_then(|c| c.rgb()) {
                        cell.insert("fc".into(), Json::from(format!("#{r:02X}{g:02X}{b:02X}")));
                    }
                }
                if let Some((glyph, color)) = look.cf.as_ref().and_then(|l| l.icon.as_ref()).map(|(set, i)| icon_glyph(set, *i)) {
                    cell.insert("ic".into(), json!([glyph, color]));
                }
                let css = look_css(&look, theme);
                if !css.is_empty() {
                    let next = styles.len();
                    let i = *style_index.entry(css).or_insert_with_key(|k| {
                        styles.push(k.clone());
                        next
                    });
                    cell.insert("s".into(), Json::from(i));
                }
                if let Some((_, rs, cs)) = span {
                    if cs > 1 {
                        cell.insert("cs".into(), Json::from(cs));
                    }
                    if rs > 1 {
                        cell.insert("rs".into(), Json::from(rs));
                    }
                }
                if cell.is_empty() {
                    cells.push(Json::Null);
                } else {
                    if !cell.contains_key("t") {
                        cell.insert("t".into(), Json::from(""));
                    }
                    cells.push(Json::Object(cell));
                }
            }
            rows_out.push(json!({ "i": row, "h": round1(sh.row_height(row)), "c": cells }));
        }

        let cols_out: Vec<Json> = vis_cols.iter().map(|&c| json!({ "i": c, "l": col_to_letters(c), "w": round1(sh.col_width(c)) })).collect();
        Ok(json!({
            "sheet": sheet,
            "name": sh.name,
            "range": r.to_string(),
            "nextRow": next_row,
            "moreCols": more_cols,
            "cols": cols_out,
            "rows": rows_out,
            "styles": styles,
        })
        .to_string())
    }
}

/// The indexes from `start` to `end` (inclusive) that aren't hidden, at most `limit` of them,
/// and whether more visible ones were left out.
fn visible(start: u32, end: u32, limit: u32, hidden: impl Fn(u32) -> bool) -> (Vec<u32>, bool) {
    let limit = usize::try_from(limit).unwrap_or(usize::MAX);
    let mut out = Vec::new();
    let mut i = start;
    loop {
        if !hidden(i) {
            if out.len() >= limit {
                return (out, true);
            }
            out.push(i);
        }
        if i >= end {
            return (out, false);
        }
        i = i.saturating_add(1);
    }
}

fn round1(x: f32) -> f64 {
    (f64::from(x) * 10.0).round() / 10.0
}

/// A cell's effective look: its own style, its table's style, and conditional formats.
struct Look {
    style: Style,
    /// Fill from a colour scale, over the style's own fill.
    scale_fill: Option<[u8; 3]>,
    cf: Option<CfLook>,
}

fn cell_look(wb: &Workbook, sheet: usize, sh: &Sheet, c: CellRef, cf: &mut Option<CfCache>) -> Look {
    let mut style = match sh.table_at(c) {
        Some(t) => gridcraft_engine::tables::table_cell_style(wb, sheet, t, c),
        None => wb.styles.get(sh.style_id(c)).clone(),
    };
    let cfl = cf.as_mut().and_then(|cache| cache.look(wb, sheet, c));
    if let Some(st) = cfl.as_ref().and_then(|l| l.style.as_ref()) {
        if st.fill.pattern != PatternType::None {
            style.fill = st.fill;
        }
        if st.font.color != Color::Auto {
            style.font.color = st.font.color;
        }
        style.font.bold |= st.font.bold;
        style.font.italic |= st.font.italic;
        style.font.strike |= st.font.strike;
        if st.font.underline != Underline::None {
            style.font.underline = st.font.underline;
        }
        // In a differential style General means "not set".
        if st.num_fmt.as_str() != "General" {
            style.num_fmt = st.num_fmt.clone();
        }
        for (dst, src) in [
            (&mut style.borders.left, st.borders.left),
            (&mut style.borders.right, st.borders.right),
            (&mut style.borders.top, st.borders.top),
            (&mut style.borders.bottom, st.borders.bottom),
        ] {
            if src.style != BorderStyle::None {
                *dst = src;
            }
        }
    }
    let scale_fill = cfl.as_ref().and_then(|l| l.scale_fill);
    Look { style, scale_fill, cf: cfl }
}

fn hex3([r, g, b]: [u8; 3]) -> String {
    format!("#{r:02X}{g:02X}{b:02X}")
}

/// Relative luminance (0 dark .. 1 light).
fn luminance([r, g, b]: [u8; 3]) -> f64 {
    let lin = |v: u8| {
        let v = f64::from(v) / 255.0;
        if v <= 0.03928 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
    };
    0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/// CSS for a cell's look. Plain cells follow the Obsidian theme: black text and white fills are
/// left out (readable in dark mode). On a coloured fill, automatic or black text becomes black
/// or white, whichever reads better on that fill.
fn look_css(look: &Look, theme: &Theme) -> String {
    let s = &look.style;
    let mut css = String::new();
    let f = &s.font;
    if f.bold {
        css.push_str("font-weight:bold;");
    }
    if f.italic {
        css.push_str("font-style:italic;");
    }
    let mut deco = Vec::new();
    if f.underline != Underline::None {
        deco.push("underline");
    }
    if f.strike {
        deco.push("line-through");
    }
    if !deco.is_empty() {
        css.push_str(&format!("text-decoration:{};", deco.join(" ")));
    }
    if f.size.is_finite() && f.size > 1.0 && (f.size - 11.0).abs() > 0.05 {
        css.push_str(&format!("font-size:{:.3}em;", f.size.clamp(4.0, 96.0) / 11.0));
    }

    let fill = look.scale_fill.or_else(|| match s.fill.pattern {
        PatternType::None => None,
        // Patterns other than solid are drawn as their foreground colour.
        _ => s.fill.fg.resolve(theme).filter(|rgb| *rgb != [255, 255, 255]),
    });
    let text = f.color.resolve(theme).filter(|rgb| *rgb != [0, 0, 0]);
    match (fill, text) {
        (Some(bg), None) => {
            css.push_str(&format!("background-color:{};", hex3(bg)));
            css.push_str(if luminance(bg) > 0.4 { "color:#000000;" } else { "color:#FFFFFF;" });
        }
        (Some(bg), Some(fg)) => css.push_str(&format!("background-color:{};color:{};", hex3(bg), hex3(fg))),
        (None, Some(fg)) => css.push_str(&format!("color:{};", hex3(fg))),
        (None, None) => {}
    }
    if let Some((frac, rgb, gradient)) = look.cf.as_ref().and_then(|l| l.bar) {
        let pct = (f64::from(frac.clamp(0.0, 1.0)) * 100.0).round();
        let [r, g, b] = rgb;
        let bar = if gradient {
            format!("linear-gradient(to right, rgba({r},{g},{b},0.75), rgba({r},{g},{b},0.15) {pct}%, transparent {pct}%)")
        } else {
            format!("linear-gradient(to right, rgba({r},{g},{b},0.6) {pct}%, transparent {pct}%)")
        };
        css.push_str(&format!("background-image:{bar};background-repeat:no-repeat;background-size:100% 70%;background-position:left center;"));
    }

    let b = &s.borders;
    for (side, line) in [("top", &b.top), ("right", &b.right), ("bottom", &b.bottom), ("left", &b.left)] {
        if let Some(v) = border_css(line, theme) {
            css.push_str(&format!("border-{side}:{v};"));
        }
    }
    match s.align.h {
        HAlign::Left => css.push_str("text-align:left;"),
        HAlign::Center | HAlign::CenterAcross => css.push_str("text-align:center;"),
        HAlign::Right => css.push_str("text-align:right;"),
        HAlign::Justify | HAlign::Distributed => css.push_str("text-align:justify;"),
        HAlign::General | HAlign::Fill => {}
    }
    match s.align.v {
        VAlign::Top => css.push_str("vertical-align:top;"),
        VAlign::Center | VAlign::Justify | VAlign::Distributed => css.push_str("vertical-align:middle;"),
        VAlign::Bottom => {}
    }
    if s.align.wrap {
        css.push_str("white-space:pre-wrap;");
    }
    if s.align.indent > 0 {
        css.push_str(&format!("padding-left:{:.2}em;", f32::from(s.align.indent.min(15)) * 0.75 + 0.3));
    }
    css
}

/// A conditional-format icon as a text glyph and colour; index 0 is the lowest of `set`'s icons.
fn icon_glyph(set: &str, index: usize) -> (&'static str, &'static str) {
    let n = gridcraft_engine::model::icon_count(set).max(2);
    let i = index.min(n - 1);
    let step = (i * 4) / (n - 1); // 0..=4, low to high
    let color = ["#D9534F", "#E8853B", "#E5B92A", "#8BBF3F", "#3EA55A"].get(step).copied().unwrap_or("#3EA55A");
    let s = set.to_ascii_lowercase();
    let pick = |glyphs: &[&'static str]| glyphs.get((step * (glyphs.len() - 1)) / 4).copied().unwrap_or("\u{25CF}");
    let glyph = if s.contains("arrow") {
        pick(&["\u{2193}", "\u{2198}", "\u{2192}", "\u{2197}", "\u{2191}"])
    } else if s.contains("rating") || s.contains("bars") {
        pick(&["\u{2581}", "\u{2583}", "\u{2585}", "\u{2587}", "\u{2588}"])
    } else if s.contains("quarters") {
        pick(&["\u{25CB}", "\u{25D4}", "\u{25D1}", "\u{25D5}", "\u{25CF}"])
    } else if s.contains("star") {
        pick(&["\u{2606}", "\u{2BEA}", "\u{2605}"])
    } else if s.contains("triangle") {
        pick(&["\u{25BC}", "\u{25AC}", "\u{25B2}"])
    } else if s.contains("flag") {
        "\u{2691}"
    } else {
        "\u{25CF}"
    };
    (glyph, color)
}

/// `#RRGGBB`, or `None` for automatic colours and for `skip` (the colour that would fight the
/// Obsidian theme).
fn color_hex(c: Color, theme: &Theme, skip: [u8; 3]) -> Option<String> {
    let rgb = c.resolve(theme)?;
    if rgb == skip {
        return None;
    }
    let [r, g, b] = rgb;
    Some(format!("#{r:02X}{g:02X}{b:02X}"))
}

fn border_css(line: &BorderLine, theme: &Theme) -> Option<String> {
    let (width, kind) = match line.style {
        BorderStyle::None => return None,
        BorderStyle::Thin => (1, "solid"),
        BorderStyle::Hair => (1, "dotted"),
        BorderStyle::Dotted => (1, "dotted"),
        BorderStyle::Dashed | BorderStyle::DashDot | BorderStyle::DashDotDot => (1, "dashed"),
        BorderStyle::Medium => (2, "solid"),
        BorderStyle::MediumDashed | BorderStyle::MediumDashDot | BorderStyle::MediumDashDotDot | BorderStyle::SlantDashDot => (2, "dashed"),
        BorderStyle::Thick => (3, "solid"),
        BorderStyle::Double => (3, "double"),
    };
    let color = color_hex(line.color, theme, [0, 0, 0]).unwrap_or_else(|| "var(--gc-border-auto)".to_string());
    Some(format!("{width}px {kind} {color}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visible_skips_hidden_and_stops_at_limit() {
        let (v, more) = visible(0, 9, 3, |i| i == 1);
        assert_eq!(v, vec![0, 2, 3]);
        assert!(more);
        let (v, more) = visible(5, 5, 10, |_| false);
        assert_eq!(v, vec![5]);
        assert!(!more);
    }

    #[test]
    fn opens_csv_and_renders() {
        let book = Book::open("t.csv", b"Name,Qty\nBolts,12\nNuts,=B2*2\n").unwrap_or_else(|_| std::process::abort());
        let info: Json = serde_json::from_str(&book.info()).unwrap_or_default();
        assert_eq!(info["sheets"].as_array().map(Vec::len), Some(1));
        let out = book.render(0, "", 0, 0).unwrap_or_else(|_| std::process::abort());
        let v: Json = serde_json::from_str(&out).unwrap_or_default();
        assert_eq!(v["rows"][0]["c"][0]["t"], "Name");
        assert_eq!(v["rows"][1]["c"][1]["a"], "r");
        assert_eq!(v["cols"][1]["l"], "B");
    }

    fn text_at(book: &Book, range: &str) -> Json {
        let out = book.render(0, range, 0, 0).unwrap_or_else(|_| std::process::abort());
        let v: Json = serde_json::from_str(&out).unwrap_or_default();
        v["rows"][0]["c"][0]["t"].clone()
    }

    #[test]
    fn formatting_commands_and_tables_render_with_colour() {
        let mut book = Book::open("t.csv", b"Item,Qty\nBolts,12\nNuts,30\nWashers,7\n").unwrap_or_else(|_| std::process::abort());
        book.run(0, "home.bold", r#"{"range":"A1:B1"}"#).unwrap_or_else(|_| std::process::abort());
        book.run(0, "home.fillColor", r##"{"range":"B2","color":"#FFC000"}"##).unwrap_or_else(|_| std::process::abort());
        let fmt: Json = serde_json::from_str(&book.cell_format(0, "A1").unwrap_or_default()).unwrap_or_default();
        assert_eq!(fmt["bold"], true);
        let out: Json = serde_json::from_str(&book.render(0, "A1:B4", 0, 0).unwrap_or_default()).unwrap_or_default();
        let css = |r: usize, c: usize| {
            let i = out["rows"][r]["c"][c]["s"].as_u64().unwrap_or(u64::MAX) as usize;
            out["styles"][i].as_str().unwrap_or("").to_string()
        };
        assert!(css(0, 0).contains("font-weight:bold"));
        assert!(css(1, 1).contains("background-color:#FFC000") && css(1, 1).contains("color:#000000"));
        assert!(book.undo().unwrap_or(false));

        book.run(0, "home.formatAsTable", r#"{"range":"A1:B4","style":"TableStyleMedium2"}"#).unwrap_or_else(|_| std::process::abort());
        let fmt: Json = serde_json::from_str(&book.cell_format(0, "A2").unwrap_or_default()).unwrap_or_default();
        assert_eq!(fmt["table"]["style"], "TableStyleMedium2");
        let out: Json = serde_json::from_str(&book.render(0, "A1:B4", 0, 0).unwrap_or_default()).unwrap_or_default();
        let i = out["rows"][0]["c"][0]["s"].as_u64().unwrap_or(u64::MAX) as usize;
        assert!(out["styles"][i].as_str().unwrap_or("").contains("background-color:#"), "{out}");

        let pal: Json = serde_json::from_str(&book.palette()).unwrap_or_default();
        assert_eq!(pal["theme"].as_array().map(Vec::len), Some(10));
        let styles: Json = serde_json::from_str(&book.table_styles()).unwrap_or_default();
        assert_eq!(styles.as_array().map(Vec::len), Some(60));
    }

    #[test]
    fn edits_undo_redo_and_save() {
        let mut book = Book::open("t.csv", b"Name,Qty\nBolts,12\n").unwrap_or_else(|_| std::process::abort());
        assert!(!book.is_dirty());
        book.set_cell(0, "C2", "=B2*2").unwrap_or_else(|_| std::process::abort());
        assert_eq!(text_at(&book, "C2"), "24");
        assert_eq!(book.edit_text(0, "C2").unwrap_or_default(), "=B2*2");
        book.set_cell(0, "B2", "20").unwrap_or_else(|_| std::process::abort());
        assert_eq!(text_at(&book, "C2"), "40");
        assert!(book.is_dirty() && book.can_undo());
        assert!(book.undo().unwrap_or(false));
        assert_eq!(text_at(&book, "C2"), "24");
        assert!(book.redo().unwrap_or(false));
        assert_eq!(text_at(&book, "C2"), "40");
        let bytes = book.save("t.csv").unwrap_or_default();
        assert!(!book.is_dirty());
        assert_eq!(String::from_utf8_lossy(&bytes).lines().nth(1), Some("Bolts,20,40"));
        let xlsx = book.save("t.xlsx").unwrap_or_default();
        let back = Book::open("t.xlsx", &xlsx).unwrap_or_else(|_| std::process::abort());
        assert_eq!(text_at(&back, "C2"), "40");
        assert_eq!(back.edit_text(0, "C2").unwrap_or_default(), "=B2*2");
    }
}
