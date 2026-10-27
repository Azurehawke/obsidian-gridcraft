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
use gridcraft_engine::{DocState, Session, Trust};
use gridcraft_engine::model::{BorderLine, BorderStyle, Color, Fill, HAlign, PatternType, Style, StyleId, Theme, Underline, VAlign, Visibility, Workbook};
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
        let mut style_index: HashMap<StyleId, usize> = HashMap::new();
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
                let id = sh.style_id(src);
                let style = wb.styles.get(id);
                let value = sh.value(src);
                let mut cell = Map::new();
                if !matches!(value, Value::Empty) {
                    let f = gridcraft_engine::display::format(&value, style.num_fmt.as_str(), wb);
                    cell.insert("t".into(), Json::from(f.text));
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
                if id != StyleId::default() {
                    let next = styles.len();
                    let i = *style_index.entry(id).or_insert_with(|| {
                        styles.push(style_css(style, theme));
                        next
                    });
                    if styles.get(i).is_some_and(|css| !css.is_empty()) {
                        cell.insert("s".into(), Json::from(i));
                    }
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

/// CSS for a cell style. Black text and white fills are left out, so cells follow the
/// Obsidian theme (readable in dark mode) unless the workbook chose a real colour.
fn style_css(s: &Style, theme: &Theme) -> String {
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
    if let Some(hex) = color_hex(f.color, theme, [0, 0, 0]) {
        css.push_str(&format!("color:{hex};"));
    }
    if let Some(hex) = fill_hex(&s.fill, theme) {
        css.push_str(&format!("background-color:{hex};"));
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

fn fill_hex(fill: &Fill, theme: &Theme) -> Option<String> {
    match fill.pattern {
        PatternType::None => None,
        // Patterns other than solid are drawn as their foreground colour.
        _ => color_hex(fill.fg, theme, [255, 255, 255]),
    }
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
