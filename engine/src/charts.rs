//! Charts as SVG, for the plugin to place over the grid.
//!
//! The drawing comes from GridCraft's chart crate (data resolution and layout into primitives);
//! turning primitives into SVG follows GridCraft's own Save as Web Page export
//! (`crates/engine/src/chart_svg.rs`, MIT OR Apache-2.0), which isn't public API.

use std::fmt::Write as _;

use gridcraft_chart::{HAlign, Prim, Rgba, VAlign};
use gridcraft_engine::model::{Chart, Workbook};

/// Widest or tallest chart drawn; larger anchors are clamped.
const MAX_SIDE: f32 = 8_192.0;

struct HelveticaMeasure;

impl gridcraft_chart::Measure for HelveticaMeasure {
    fn text_width(&self, text: &str, size: f32, bold: bool) -> f32 {
        gridcraft_pdf::text_width(if bold { gridcraft_pdf::Font::HelveticaBold } else { gridcraft_pdf::Font::Helvetica }, size, text)
    }
}

/// `chart` of sheet `sheet` as an `<svg>` element of its anchored size, or `None` for a
/// degenerate size.
pub fn chart_svg(wb: &Workbook, sheet: usize, chart: &Chart) -> Option<String> {
    let (w, h) = (chart.anchor.width.min(MAX_SIDE), chart.anchor.height.min(MAX_SIDE));
    if !(w >= 1.0 && h >= 1.0) {
        return None;
    }
    let data = gridcraft_chart::resolve(wb, sheet, chart);
    let prims = gridcraft_chart::render(chart, &data, w, h, &HelveticaMeasure);
    Some(prims_svg(&prims, w, h))
}

fn prims_svg(prims: &[Prim], w: f32, h: f32) -> String {
    let mut out = String::new();
    let _ = write!(
        out,
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{}\" height=\"{}\" viewBox=\"0 0 {} {}\" font-family=\"Helvetica,Arial,sans-serif\">",
        num(w),
        num(h),
        num(w),
        num(h)
    );
    for p in prims {
        match p {
            Prim::Rect { x, y, w, h, fill, stroke, radius } => {
                let _ = write!(out, "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\"", num(*x), num(*y), num(*w), num(*h));
                if *radius > 0.0 {
                    let _ = write!(out, " rx=\"{}\"", num(*radius));
                }
                paint(&mut out, *fill, *stroke);
                out.push_str("/>");
            }
            Prim::Line { pts, color, width, dash } => {
                let _ = write!(out, "<polyline points=\"{}\"", points(pts));
                paint(&mut out, None, Some((*color, *width)));
                if *dash {
                    out.push_str(" stroke-dasharray=\"3 2\"");
                }
                out.push_str("/>");
            }
            Prim::Polygon { pts, fill, stroke } => {
                let _ = write!(out, "<polygon points=\"{}\"", points(pts));
                paint(&mut out, Some(*fill), *stroke);
                out.push_str("/>");
            }
            Prim::Wedge { cx, cy, r_outer, r_inner, a0, a1, fill, stroke } => {
                let _ = write!(out, "<path d=\"{}\"", wedge_path(*cx, *cy, *r_outer, *r_inner, *a0, *a1));
                paint(&mut out, Some(*fill), *stroke);
                out.push_str("/>");
            }
            Prim::Circle { cx, cy, r, fill, stroke } => {
                let _ = write!(out, "<circle cx=\"{}\" cy=\"{}\" r=\"{}\"", num(*cx), num(*cy), num(*r));
                paint(&mut out, *fill, *stroke);
                out.push_str("/>");
            }
            Prim::Text { x, y, text, size, color, bold, align, valign, rotation } => {
                let dy = match valign {
                    VAlign::Top => size * 0.78,
                    VAlign::Middle => size * 0.35,
                    VAlign::Bottom => -size * 0.21,
                };
                let anchor = match align {
                    HAlign::Left => "start",
                    HAlign::Center => "middle",
                    HAlign::Right => "end",
                };
                let _ = write!(out, "<text x=\"{}\" y=\"{}\" font-size=\"{}\" text-anchor=\"{anchor}\"", num(*x), num(y + dy), num(*size));
                if *bold {
                    out.push_str(" font-weight=\"bold\"");
                }
                if rotation.is_finite() && *rotation != 0.0 {
                    let _ = write!(out, " transform=\"rotate({} {} {})\"", num(rotation.to_degrees()), num(*x), num(*y));
                }
                let _ = write!(out, " fill=\"{}\"{}>{}</text>", hex(*color), opacity("fill", *color), esc(text));
            }
        }
    }
    out.push_str("</svg>");
    out
}

fn paint(out: &mut String, fill: Option<Rgba>, stroke: Option<(Rgba, f32)>) {
    match fill {
        Some(c) => {
            let _ = write!(out, " fill=\"{}\"{}", hex(c), opacity("fill", c));
        }
        None => out.push_str(" fill=\"none\""),
    }
    if let Some((c, w)) = stroke {
        let _ = write!(out, " stroke=\"{}\" stroke-width=\"{}\"{}", hex(c), num(w), opacity("stroke", c));
    }
}

/// A pie or doughnut sector. Angles run clockwise from 12 o'clock, like the chart crate's.
fn wedge_path(cx: f32, cy: f32, r_outer: f32, r_inner: f32, a0: f32, a1: f32) -> String {
    let span = (a1 - a0).clamp(-std::f32::consts::TAU + 0.001, std::f32::consts::TAU - 0.001);
    let a1 = a0 + span;
    let at = |a: f32, r: f32| format!("{} {}", num(cx + r * a.sin()), num(cy - r * a.cos()));
    let large = u8::from(span.abs() > std::f32::consts::PI);
    let sweep = u8::from(span >= 0.0);
    let mut d = format!("M{} A{r} {r} 0 {large} {sweep} {}", at(a0, r_outer), at(a1, r_outer), r = num(r_outer));
    if r_inner > 0.0 {
        let _ = write!(d, " L{} A{r} {r} 0 {large} {} {} Z", at(a1, r_inner), 1 - sweep, at(a0, r_inner), r = num(r_inner));
    } else {
        let _ = write!(d, " L{} {} Z", num(cx), num(cy));
    }
    d
}

fn points(pts: &[[f32; 2]]) -> String {
    pts.iter().map(|p| format!("{},{}", num(p[0]), num(p[1]))).collect::<Vec<_>>().join(" ")
}

fn hex(c: Rgba) -> String {
    format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])
}

fn opacity(attr: &str, c: Rgba) -> String {
    if c[3] == 255 { String::new() } else { format!(" {attr}-opacity=\"{:.2}\"", f32::from(c[3]) / 255.0) }
}

/// A coordinate with two decimals; a non-finite value is 0 so the SVG stays well-formed.
fn num(v: f32) -> String {
    if !v.is_finite() {
        return "0".into();
    }
    let s = format!("{v:.2}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// Text for SVG markup: workbook text (titles, labels) never becomes markup.
fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c if (c as u32) < 0x20 && c != '\t' && c != '\n' => {}
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_is_escaped_and_numbers_stay_finite() {
        let prims = vec![
            Prim::Text {
                x: 1.0,
                y: 2.0,
                text: "<script>&".into(),
                size: 10.0,
                color: [0, 0, 0, 255],
                bold: false,
                align: HAlign::Left,
                valign: VAlign::Top,
                rotation: 0.0,
            },
            Prim::Circle { cx: f32::NAN, cy: 1.0, r: 1.0, fill: None, stroke: None },
        ];
        let svg = prims_svg(&prims, 10.0, 10.0);
        assert!(svg.contains("&lt;script&gt;&amp;") && !svg.contains("<script>"), "{svg}");
        assert!(svg.contains("<circle cx=\"0\""), "{svg}");
    }
}
