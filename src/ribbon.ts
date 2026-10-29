// The formatting toolbar above the grid: font, colours, borders, alignment, number formats,
// Format as Table. Every button runs a GridCraft command on the selected range.

import { Menu, setIcon } from "obsidian";
import { CHART_TYPES } from "./charts";

export interface TableInfo {
	name: string;
	style: string;
	header: boolean;
	totals: boolean;
	banded: boolean;
	bandedCols: boolean;
	firstCol: boolean;
	lastCol: boolean;
}

export interface CellFormat {
	bold: boolean;
	italic: boolean;
	underline: boolean;
	strike: boolean;
	wrap: boolean;
	h: string;
	v: string;
	numFmt: string;
	size: number;
	font: string;
	fontColor: string | null;
	fill: string | null;
	merged: boolean;
	table: TableInfo | null;
}

export interface Palette {
	theme: { theme: number; tint: number; hex: string | null }[][];
	standard: string[];
}

export interface TableStyleInfo {
	name: string;
	family: string;
	header: string | null;
	headerFont: string | null;
	band: string | null;
	body: string | null;
	line: string | null;
}

export interface RibbonHost {
	/** Runs a GridCraft command; `range` (the selection) is added unless `withRange` is false. */
	run(id: string, params?: Record<string, unknown>, withRange?: boolean): void;
	format(): CellFormat | null;
	palette(): Palette | null;
	tableStyles(): TableStyleInfo[];
	/** Asks for an exact column width or row height for the selection. */
	resize(what: "width" | "height"): void;
	/** Inserts a chart of the selected data. */
	insertChart(type: string, subtype?: string): void;
	/** Asks for a range on any sheet and inserts a chart of it here. */
	insertChartFrom(): void;
	/** Frozen [rows, columns] of the sheet, or null. */
	frozen(): [number, number] | null;
	/** The active cell in A1 notation. */
	activeCell(): string | null;
}

type Color = string | { theme: number; tint: number };

const NUMBER_FORMATS: [string, string][] = [
	["General", "General"],
	["Number", "Number"],
	["Currency", "Currency"],
	["Accounting", "Accounting"],
	["Short Date", "Short date"],
	["Long Date", "Long date"],
	["Time", "Time"],
	["Percentage", "Percentage"],
	["Fraction", "Fraction"],
	["Scientific", "Scientific"],
	["Text", "Text"],
];

const BORDERS: [string, string][] = [
	["bottom", "Bottom border"],
	["top", "Top border"],
	["left", "Left border"],
	["right", "Right border"],
	["all", "All borders"],
	["outside", "Outside borders"],
	["thickOutside", "Thick outside borders"],
	["inside", "Inside borders"],
	["topBottom", "Top and bottom borders"],
	["thickBottom", "Thick bottom border"],
	["doubleBottom", "Double bottom border"],
	["none", "No border"],
];

const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48];

export class Ribbon {
	readonly el: HTMLElement;
	private toggles = new Map<string, HTMLElement>();
	private sizeEl!: HTMLElement;
	private numberEl!: HTMLElement;
	private fontBar!: HTMLElement;
	private fillBar!: HTMLElement;
	private fontColor: Color = "#C00000";
	private fillColor: Color = "#FFFF00";
	private fontHex = "#C00000";
	private fillHex = "#FFFF00";

	constructor(parent: HTMLElement, private host: RibbonHost) {
		this.el = parent.createDiv({ cls: "gc-ribbon" });
		this.build();
	}

	private group(): HTMLElement {
		return this.el.createDiv({ cls: "gc-group" });
	}

	private button(parent: HTMLElement, icon: string, label: string, onClick: (e: MouseEvent) => void, text?: string): HTMLElement {
		const b = parent.createDiv({ cls: "clickable-icon gc-rb", attr: { "aria-label": label } });
		if (text) b.createSpan({ cls: "gc-rb-text", text });
		else {
			setIcon(b, icon);
			// An icon this Obsidian doesn't have: show the label's first word instead.
			if (!b.querySelector("svg")) b.createSpan({ cls: "gc-rb-text", text: label.split(" ")[0] });
		}
		b.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus (and the selection) in the grid
		b.addEventListener("click", (e) => onClick(e));
		return b;
	}

	private toggle(parent: HTMLElement, key: string, icon: string, label: string, onClick: (on: boolean) => void) {
		const b = this.button(parent, icon, label, () => onClick(!b.hasClass("is-active")));
		this.toggles.set(key, b);
	}

	private build() {
		const run = (id: string, params: Record<string, unknown> = {}) => this.host.run(id, params);

		let g = this.group();
		this.toggle(g, "bold", "bold", "Bold (Ctrl+B)", (on) => run("home.bold", { on }));
		this.toggle(g, "italic", "italic", "Italic (Ctrl+I)", (on) => run("home.italic", { on }));
		this.toggle(g, "underline", "underline", "Underline (Ctrl+U)", (on) => run("home.underline", { on }));
		this.toggle(g, "strike", "strikethrough", "Strikethrough", (on) => run("home.strikethrough", { on }));

		g = this.group();
		this.sizeEl = this.button(g, "", "Font size", (e) => {
			const m = new Menu();
			for (const size of FONT_SIZES) m.addItem((i) => i.setTitle(String(size)).onClick(() => run("home.fontSize", { size })));
			m.showAtMouseEvent(e);
		}, "11");
		this.sizeEl.addClass("gc-rb-size");
		this.button(g, "", "Increase font size", () => run("home.increaseFontSize"), "A+");
		this.button(g, "", "Decrease font size", () => run("home.decreaseFontSize"), "A−");

		g = this.group();
		const font = this.button(g, "baseline", "Font colour", () => run("home.fontColor", { color: this.fontColor }));
		this.fontBar = font.createDiv({ cls: "gc-colorbar" });
		this.button(g, "chevron-down", "More font colours", (e) =>
			this.colorPicker(e.currentTarget as HTMLElement, "Automatic", (c, hex) => {
				if (c !== "auto") {
					this.fontColor = c;
					this.fontHex = hex;
				}
				this.paintBars();
				run("home.fontColor", { color: c });
			}),
		).addClass("gc-rb-arrow");
		const fill = this.button(g, "paint-bucket", "Fill colour", () => run("home.fillColor", { color: this.fillColor }));
		this.fillBar = fill.createDiv({ cls: "gc-colorbar" });
		this.button(g, "chevron-down", "More fill colours", (e) =>
			this.colorPicker(e.currentTarget as HTMLElement, "No fill", (c, hex) => {
				if (c !== "none") {
					this.fillColor = c;
					this.fillHex = hex;
				}
				this.paintBars();
				run("home.fillColor", { color: c === "auto" ? "none" : c });
			}),
		).addClass("gc-rb-arrow");
		this.button(g, "grid-2x2", "Borders", (e) => {
			const m = new Menu();
			for (const [preset, title] of BORDERS) m.addItem((i) => i.setTitle(title).onClick(() => run("home.borders", { preset })));
			m.showAtMouseEvent(e);
		});
		this.paintBars();

		g = this.group();
		this.toggle(g, "Left", "align-left", "Align left", () => run("home.alignLeft"));
		this.toggle(g, "Center", "align-center", "Centre", () => run("home.alignCenter"));
		this.toggle(g, "Right", "align-right", "Align right", () => run("home.alignRight"));
		this.button(g, "move-vertical", "Vertical alignment", (e) => {
			const m = new Menu();
			m.addItem((i) => i.setTitle("Top").onClick(() => run("home.alignTop")));
			m.addItem((i) => i.setTitle("Middle").onClick(() => run("home.alignMiddle")));
			m.addItem((i) => i.setTitle("Bottom").onClick(() => run("home.alignBottom")));
			m.showAtMouseEvent(e);
		});
		this.toggle(g, "wrap", "wrap-text", "Wrap text", (on) => run("home.wrapText", { on }));
		this.toggle(g, "merged", "merge", "Merge & centre", (on) => run(on ? "home.mergeCenter" : "home.unmergeCells"));

		g = this.group();
		this.numberEl = this.button(g, "", "Number format", (e) => {
			const m = new Menu();
			for (const [format, title] of NUMBER_FORMATS) m.addItem((i) => i.setTitle(title).onClick(() => run("home.numberFormat", { format })));
			m.showAtMouseEvent(e);
		}, "General");
		this.numberEl.addClass("gc-rb-number");
		this.button(g, "", "Currency", () => run("home.numberFormat", { format: "Currency" }), "$");
		this.button(g, "", "Percent style", () => run("home.percent"), "%");
		this.button(g, "", "Comma style", () => run("home.comma"), ",");
		this.button(g, "", "Increase decimal", () => run("home.increaseDecimal"), ".0+");
		this.button(g, "", "Decrease decimal", () => run("home.decreaseDecimal"), ".0−");

		g = this.group();
		this.button(g, "table", "Format as table", (e) => this.tableGallery(e.currentTarget as HTMLElement));
		this.button(g, "bar-chart-2", "Insert chart", (e) => {
			const m = new Menu();
			m.addItem((i) => i.setTitle("From another sheet…").setIcon("table").onClick(() => this.host.insertChartFrom()));
				m.addSeparator();
				for (const [title, type, subtype] of CHART_TYPES) m.addItem((i) => i.setTitle(title).onClick(() => this.host.insertChart(type, subtype)));
			m.showAtMouseEvent(e);
		});
		this.button(g, "ruler", "Column width and row height", (e) => {
			const m = new Menu();
			m.addItem((i) => i.setTitle("Column width…").setIcon("move-horizontal").onClick(() => this.host.resize("width")));
			m.addItem((i) => i.setTitle("AutoFit column width").onClick(() => run("home.autofitColumnWidth")));
			m.addSeparator();
			m.addItem((i) => i.setTitle("Row height…").setIcon("move-vertical").onClick(() => this.host.resize("height")));
			m.addItem((i) => i.setTitle("AutoFit row height").onClick(() => run("home.autofitRowHeight")));
			m.showAtMouseEvent(e);
		});
		this.button(g, "eraser", "Clear formats", () => run("edit.clearFormats"));

		g = this.group();
		this.button(g, "snowflake", "Freeze panes", (e) => {
			const frozen = this.host.frozen();
			const at = this.host.activeCell();
			const m = new Menu();
			if (frozen) m.addItem((i) => i.setTitle("Unfreeze panes").setIcon("lock-open").onClick(() => this.host.run("view.unfreezePanes", {}, false)));
			if (at) {
				m.addItem((i) =>
					i
						.setTitle(`Freeze panes above and left of ${at}`)
						.setIcon("snowflake")
						.onClick(() => this.host.run("view.freezePanes", { cell: at }, false)),
				);
			}
			m.addItem((i) => i.setTitle("Freeze top row").onClick(() => this.host.run("view.freezeTopRow", {}, false)));
			m.addItem((i) => i.setTitle("Freeze first column").onClick(() => this.host.run("view.freezeFirstColumn", {}, false)));
			m.showAtMouseEvent(e);
		});
	}

	/** Shows the selected cell's format on the toggle buttons. */
	update(f: CellFormat | null) {
		const on = (key: string, v: boolean) => this.toggles.get(key)?.toggleClass("is-active", v);
		on("bold", !!f?.bold);
		on("italic", !!f?.italic);
		on("underline", !!f?.underline);
		on("strike", !!f?.strike);
		on("wrap", !!f?.wrap);
		on("merged", !!f?.merged);
		for (const h of ["Left", "Center", "Right"]) on(h, f?.h === h);
		const size = f?.size ?? 11;
		this.sizeEl.querySelector(".gc-rb-text")?.setText(String(Math.round(size * 10) / 10));
		this.numberEl.querySelector(".gc-rb-text")?.setText(numberLabel(f?.numFmt ?? "General"));
	}

	private paintBars() {
		this.fontBar.style.backgroundColor = this.fontHex;
		this.fillBar.style.backgroundColor = this.fillHex;
	}

	private colorPicker(anchor: HTMLElement, autoLabel: string, pick: (c: Color, hex: string) => void) {
		const palette = this.host.palette();
		popover(anchor, (el, close) => {
			el.addClass("gc-palette");
			const auto = el.createDiv({ cls: "gc-pal-auto", text: autoLabel });
			auto.addEventListener("click", () => {
				close();
				pick(autoLabel === "No fill" ? "none" : "auto", "");
			});
			if (palette) {
				el.createDiv({ cls: "gc-pal-title", text: "Theme colours" });
				const grid = el.createDiv({ cls: "gc-pal-grid" });
				const rows = palette.theme[0]?.length ?? 0;
				for (let r = 0; r < rows; r++) {
					for (const column of palette.theme) {
						const sw = column[r];
						if (!sw?.hex) continue;
						const hex = sw.hex;
						swatch(grid, hex, `${sw.tint === 0 ? "" : `${sw.tint > 0 ? "Lighter" : "Darker"} ${Math.round(Math.abs(sw.tint) * 100)}% `}${hex}`, () => {
							close();
							pick({ theme: sw.theme, tint: sw.tint }, hex);
						});
					}
				}
				el.createDiv({ cls: "gc-pal-title", text: "Standard colours" });
				const std = el.createDiv({ cls: "gc-pal-grid" });
				for (const hex of palette.standard) {
					swatch(std, hex, hex, () => {
						close();
						pick(hex, hex);
					});
				}
			}
			el.createDiv({ cls: "gc-pal-title", text: "Custom" });
			const custom = el.createEl("input", { cls: "gc-pal-custom", attr: { type: "color", value: "#4472C4" } });
			custom.addEventListener("change", () => {
				close();
				pick(custom.value.toUpperCase(), custom.value);
			});
		});
	}

	private tableGallery(anchor: HTMLElement) {
		const styles = this.host.tableStyles();
		const f = this.host.format();
		const table = f?.table ?? null;
		popover(anchor, (el, close) => {
			el.addClass("gc-tables");
			if (table) {
				el.createDiv({ cls: "gc-pal-title", text: `${table.name} options` });
				const opts = el.createDiv({ cls: "gc-table-opts" });
				const option = (label: string, value: boolean, id: string) => {
					const row = opts.createEl("label");
					const cb = row.createEl("input", { attr: { type: "checkbox" } });
					cb.checked = value;
					row.appendText(` ${label}`);
					cb.addEventListener("change", () => this.host.run(id, { table: table.name, on: cb.checked }, false));
				};
				option("Total row", table.totals, "table.totalRow");
				option("Banded rows", table.banded, "table.bandedRows");
				option("Banded columns", table.bandedCols, "table.bandedColumns");
				option("First column", table.firstCol, "table.firstColumn");
				option("Last column", table.lastCol, "table.lastColumn");
				const convert = opts.createEl("button", { text: "Convert to range" });
				convert.addEventListener("click", () => {
					close();
					this.host.run("table.convertToRange", { table: table.name }, false);
				});
			}
			for (const family of ["Light", "Medium", "Dark"]) {
				el.createDiv({ cls: "gc-pal-title", text: family });
				const grid = el.createDiv({ cls: "gc-table-grid" });
				for (const s of styles.filter((x) => x.family === family)) {
					const sw = grid.createDiv({ cls: "gc-table-swatch", attr: { "aria-label": s.name.replace("TableStyle", "") } });
					if (table?.style === s.name) sw.addClass("is-active");
					drawTableSwatch(sw, s);
					sw.addEventListener("click", () => {
						close();
						if (table) this.host.run("table.style", { table: table.name, style: s.name }, false);
						else this.host.run("home.formatAsTable", { style: s.name });
					});
				}
			}
		});
	}
}

function numberLabel(code: string): string {
	if (code === "General") return "General";
	if (code === "@") return "Text";
	if (/%/.test(code)) return "Percent";
	if (/[$€£¥]/.test(code)) return /_\(|\* /.test(code) ? "Accounting" : "Currency";
	if (/[yd]/i.test(code) && !/h/i.test(code)) return "Date";
	if (/h|s/i.test(code) && /:/.test(code)) return "Time";
	if (/E[+-]/i.test(code)) return "Scientific";
	if (/\?\/\?/.test(code)) return "Fraction";
	return "Number";
}

function swatch(parent: HTMLElement, hex: string, label: string, onClick: () => void) {
	const sw = parent.createDiv({ cls: "gc-swatch", attr: { "aria-label": label } });
	sw.style.backgroundColor = hex;
	sw.addEventListener("click", onClick);
}

/** A tiny picture of a table style: header row, then banded rows. */
function drawTableSwatch(el: HTMLElement, s: TableStyleInfo) {
	const line = s.line ?? "transparent";
	for (let r = 0; r < 5; r++) {
		const row = el.createDiv({ cls: "gc-ts-row" });
		const bg = r === 0 ? s.header ?? s.body ?? "transparent" : r % 2 === 1 ? s.band ?? s.body ?? "transparent" : s.body ?? "transparent";
		for (let c = 0; c < 3; c++) {
			const cell = row.createDiv({ cls: "gc-ts-cell" });
			cell.style.backgroundColor = bg;
			cell.style.borderBottom = `1px solid ${line}`;
			if (r === 0 && !s.header) cell.style.borderBottom = `2px solid ${s.headerFont ?? line}`;
		}
	}
}

/** A small panel under `anchor`; closes on a click outside it or Escape. */
export function popover(anchor: HTMLElement, build: (el: HTMLElement, close: () => void) => void) {
	const doc = anchor.ownerDocument;
	const pop = doc.body.createDiv({ cls: "gc-pop" });
	const close = () => {
		pop.remove();
		doc.removeEventListener("mousedown", outside, true);
		doc.removeEventListener("keydown", escape, true);
	};
	const outside = (e: MouseEvent) => {
		if (!pop.contains(e.target as Node)) close();
	};
	const escape = (e: KeyboardEvent) => {
		if (e.key === "Escape") {
			e.stopPropagation();
			close();
		}
	};
	build(pop, close);
	const r = anchor.getBoundingClientRect();
	const width = doc.documentElement.clientWidth;
	const height = doc.documentElement.clientHeight;
	pop.style.left = `${Math.max(4, Math.min(r.left, width - pop.offsetWidth - 4))}px`;
	pop.style.top = `${Math.min(r.bottom + 4, Math.max(4, height - pop.offsetHeight - 4))}px`;
	// Opened from a click, whose mousedown is already over: listening now is safe.
	doc.addEventListener("mousedown", outside, true);
	doc.addEventListener("keydown", escape, true);
}
