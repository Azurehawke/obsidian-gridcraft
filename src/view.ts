// The tab a spreadsheet opens in: a formula bar, the sheet's cells, and sheet tabs along the
// bottom. Cells are edited through GridCraft's engine (its undo history and recalculation) and
// the file is saved back to the vault a moment after each change.

import { FileView, Menu, Modal, Notice, Platform, Setting, setIcon, type App, type TFile, type WorkspaceLeaf } from "obsidian";
import { errorText, type Book, type EngineStatus } from "./engine";
import type GridCraftPlugin from "./main";
import { CHART_TYPES, ChartLayer, type ChartInfo } from "./charts";
import { colLetters, Grid, type RenderData } from "./render";
import { Ribbon, type CellFormat, type Palette, type TableStyleInfo } from "./ribbon";

export const VIEW_TYPE = "gridcraft-sheet";
export const EXTENSIONS = ["xlsx", "csv"];

/** Rows fetched per block; more are fetched as you scroll near the bottom. */
const BLOCK_ROWS = 500;
/** Empty rows and columns shown past the used range, to type into. */
const PAD_ROWS = 50;
const PAD_COLS = 6;
const MAX_ROW = 1_048_575;

/** "Data!A1:D9", "'Q1 Sales'!A1:C9" or "A1:D9" (this sheet): the sheet's name (null for this sheet) and the range. */
export function splitSource(text: string): { sheet: string | null; range: string } {
	const t = text.trim().replace(/^=/, "");
	const bang = t.lastIndexOf("!");
	if (bang < 0) return { sheet: null, range: t };
	let sheet = t.slice(0, bang).trim();
	if (sheet.length >= 2 && sheet.startsWith("'") && sheet.endsWith("'")) sheet = sheet.slice(1, -1).replace(/''/g, "'");
	return { sheet, range: t.slice(bang + 1).trim() };
}
const MAX_COL = 16_383;
/** Saved this long after the last edit. */
const SAVE_DELAY_MS = 1200;
const RIBBON_KEY = "gridcraft-viewer-ribbon";

interface SheetInfo {
	name: string;
	hidden: boolean;
	/** Frozen [rows, columns] at the top and left. */
	freeze?: [number, number] | null;
	used: string | null;
	lastRow: number | null;
	lastCol: number | null;
}

interface BookInfo {
	sheets: SheetInfo[];
	active: number;
	warnings: string[];
}

interface Pos {
	r: number;
	c: number;
}

type SaveState = "saved" | "edited" | "saving" | "failed";

export class SheetView extends FileView {
	private book: Book | null = null;
	private info: BookInfo | null = null;
	private sheet = 0;
	private grid: Grid | null = null;
	private nextRow: number | null = null;
	private fetching = false;
	private loadToken = 0;

	/** The active cell, and the other corner of the selected range. */
	private sel: Pos | null = null;
	private anchor: Pos | null = null;
	private selTd: HTMLElement | null = null;
	private inRange: HTMLElement[] = [];
	private chartLayer: ChartLayer | null = null;
	/** The selected chart's id, kept across redraws. */
	private chartSel: number | null = null;
	private dragging = false;
	private ribbon!: Ribbon;
	private ribbonBtn!: HTMLElement;
	private editor: HTMLInputElement | null = null;
	private saveTimer: number | null = null;
	private saving: Promise<void> | null = null;
	private csvFormulaWarned = false;

	private barEl!: HTMLElement;
	private nameEl!: HTMLElement;
	private formulaEl!: HTMLInputElement;
	private undoEl!: HTMLElement;
	private redoEl!: HTMLElement;
	private stateEl!: HTMLElement;
	private noticeEl!: HTMLElement;
	private scrollEl!: HTMLElement;
	private tabsEl!: HTMLElement;

	constructor(leaf: WorkspaceLeaf, private plugin: GridCraftPlugin) {
		super(leaf);
	}

	override getViewType(): string {
		return VIEW_TYPE;
	}

	override getIcon(): string {
		return "table";
	}

	override canAcceptExtension(extension: string): boolean {
		return EXTENSIONS.includes(extension.toLowerCase());
	}

	override async onLoadFile(file: TFile): Promise<void> {
		this.buildLayout();
		await this.loadBook(file);
	}

	override async onUnloadFile(file: TFile): Promise<void> {
		await this.saveNow(file);
		this.loadToken++;
		this.freeBook();
		this.contentEl.empty();
	}

	override async onClose(): Promise<void> {
		if (this.file) await this.saveNow(this.file);
		this.freeBook();
	}

	/** Re-reads the file (after it changed on disk or arrived through sync), keeping the sheet. */
	async reload() {
		if (!this.file) return;
		if (this.book?.isDirty()) new Notice(`${this.file.name} changed on disk; your unsaved edits in GridCraft Viewer were replaced by the new version.`);
		const keep = this.info?.sheets[this.sheet]?.name;
		const keepSel = this.sel;
		this.buildLayout();
		await this.loadBook(this.file, keep, keepSel);
	}

	// ----- layout -----

	private buildLayout() {
		this.cancelSave();
		this.contentEl.empty();
		this.contentEl.addClass("gc-view");
		this.editor = null;
		this.selTd = null;

		this.barEl = this.contentEl.createDiv({ cls: "gc-bar" });
		this.nameEl = this.barEl.createDiv({ cls: "gc-namebox" });
		this.barEl.createDiv({ cls: "gc-fx", text: "fx" });
		this.formulaEl = this.barEl.createEl("input", { cls: "gc-formula", attr: { type: "text", spellcheck: "false", placeholder: "" } });
		this.undoEl = this.barEl.createDiv({ cls: "clickable-icon gc-undo", attr: { "aria-label": "Undo (Ctrl+Z)" } });
		setIcon(this.undoEl, "undo");
		this.redoEl = this.barEl.createDiv({ cls: "clickable-icon gc-redo", attr: { "aria-label": "Redo (Ctrl+Y)" } });
		setIcon(this.redoEl, "redo");
		this.stateEl = this.barEl.createDiv({ cls: "gc-state" });
		this.ribbonBtn = this.barEl.createDiv({ cls: "clickable-icon gc-ribbon-toggle", attr: { "aria-label": "Show or hide formatting" } });
		setIcon(this.ribbonBtn, "palette");
		this.barEl.hide();
		this.ribbon = new Ribbon(this.contentEl, {
			run: (id, params, withRange) => this.runCommand(id, params ?? {}, withRange ?? true),
			format: () => this.currentFormat(),
			palette: () => this.parse<Palette>(() => this.book?.palette()),
			tableStyles: () => this.parse<TableStyleInfo[]>(() => this.book?.tableStyles()) ?? [],
			resize: (what) => this.askSize(what),
			insertChart: (type, subtype) => this.insertChart(type, subtype),
				insertChartFrom: () => this.askChartSource(),
			frozen: () => {
				const f = this.info?.sheets[this.sheet]?.freeze;
				return f && (f[0] > 0 || f[1] > 0) ? f : null;
			},
			activeCell: () => (this.sel ? this.a1(this.sel) : null),
		});
		this.ribbon.el.hide();

		const body = this.contentEl.createDiv({ cls: "gc-body" });
		this.noticeEl = body.createDiv({ cls: "gc-notice" });
		this.noticeEl.hide();
		this.scrollEl = body.createDiv({ cls: "gc-scroll", attr: { tabindex: "0" } });
		this.tabsEl = this.contentEl.createDiv({ cls: "gc-tabs" });

		this.registerDomEvent(this.scrollEl, "scroll", () => this.maybeFetchMore());
		this.registerDomEvent(this.scrollEl, "pointerdown", (e) => this.onResizeStart(e));
		this.registerDomEvent(this.scrollEl, "mousedown", (e) => this.onMouseDown(e));
		this.registerDomEvent(this.scrollEl, "mouseover", (e) => this.onMouseOver(e));
		this.registerDomEvent(this.contentEl.ownerDocument, "mouseup", () => (this.dragging = false));
		this.registerDomEvent(this.scrollEl, "dblclick", (e) => this.onDoubleClick(e));
		this.registerDomEvent(this.scrollEl, "keydown", (e) => this.onGridKey(e));
		this.registerDomEvent(this.scrollEl, "copy", (e) => this.onCopy(e));
		this.registerDomEvent(this.scrollEl, "paste", (e) => this.onPaste(e));
		this.registerDomEvent(this.formulaEl, "keydown", (e) => this.onFormulaKey(e));
		this.registerDomEvent(this.undoEl, "click", () => this.undoRedo(false));
		this.registerDomEvent(this.redoEl, "click", () => this.undoRedo(true));
		this.registerDomEvent(this.ribbonBtn, "click", () => {
			const show = !this.ribbonShown();
			try {
				window.localStorage.setItem(RIBBON_KEY, show ? "1" : "0");
			} catch {
				// Not kept; fine.
			}
			this.applyRibbonShown();
		});
	}

	private ribbonShown(): boolean {
		try {
			return window.localStorage.getItem(RIBBON_KEY) !== "0";
		} catch {
			return true;
		}
	}

	private applyRibbonShown() {
		const show = !!this.book && this.ribbonShown();
		this.ribbon.el.toggle(show);
		this.ribbonBtn.toggleClass("is-active", show);
	}

	private parse<T>(get: () => string | undefined): T | null {
		try {
			const text = get();
			return text ? (JSON.parse(text) as T) : null;
		} catch {
			return null;
		}
	}

	// ----- loading -----

	private async loadBook(file: TFile, sheetName?: string, keepSel?: Pos | null) {
		const token = ++this.loadToken;
		this.freeBook();
		this.message("Opening…");
		try {
			const BookClass = await this.plugin.engine.get((s) => {
				if (token === this.loadToken) this.message(statusText(s));
			});
			const bytes = await this.app.vault.readBinary(file);
			if (token !== this.loadToken) return;
			const book = BookClass.open(file.name, new Uint8Array(bytes));
			if (token !== this.loadToken) {
				book.free();
				return;
			}
			this.book = book;
			this.info = JSON.parse(book.info()) as BookInfo;
			const byName = sheetName ? this.info.sheets.findIndex((s) => s.name === sheetName) : -1;
			const active = this.info.sheets[this.info.active] && !this.info.sheets[this.info.active].hidden ? this.info.active : -1;
			const firstVisible = this.info.sheets.findIndex((s) => !s.hidden);
			this.sheet = byName >= 0 ? byName : active >= 0 ? active : Math.max(0, firstVisible);
			this.barEl.show();
			this.applyRibbonShown();
			this.setSaveState("saved");
			this.renderTabs();
			this.showSheet();
			if (keepSel && byName >= 0) this.select(keepSel.r, keepSel.c, false);
		} catch (e) {
			if (token !== this.loadToken) return;
			this.message(`GridCraft couldn't open ${file.name}.\n\n${errorText(e)}`, true);
		}
	}

	private freeBook() {
		this.cancelSave();
		this.grid = null;
		this.nextRow = null;
		this.sel = null;
		this.anchor = null;
		this.selTd = null;
		this.inRange = [];
		this.editor = null;
		if (this.book) {
			try {
				this.book.free();
			} catch {
				// Already gone with a failed engine; nothing to release.
			}
			this.book = null;
		}
	}

	private renderTabs() {
		this.tabsEl.empty();
		const sheets = this.info?.sheets ?? [];
		const visible = sheets.filter((s) => !s.hidden);
		if (visible.length <= 1 && this.file?.extension.toLowerCase() === "csv") {
			this.tabsEl.hide();
			return;
		}
		this.tabsEl.show();
		sheets.forEach((s, i) => {
			if (s.hidden) return;
			const tab = this.tabsEl.createEl("button", { cls: "gc-tab", text: s.name });
			if (i === this.sheet) tab.addClass("is-active");
			tab.addEventListener("click", () => {
				if (i === this.sheet) return;
				this.commitEdit();
				this.sheet = i;
				this.renderTabs();
				this.showSheet();
			});
		});
	}

	/** The last row and column shown: the used range plus room to type into. */
	private extent(): { endRow: number; endCol: number } {
		const info = this.info?.sheets[this.sheet];
		const lastRow = info?.lastRow ?? -1;
		const lastCol = info?.lastCol ?? -1;
		return {
			endRow: Math.min(MAX_ROW, Math.max(lastRow, 0) + PAD_ROWS),
			endCol: Math.min(MAX_COL, Math.max(lastCol + PAD_COLS, 9)),
		};
	}

	/** Draws the sheet from the top, or (keep) redraws the rows already shown, keeping the scroll position. */
	private showSheet(keep = false) {
		const book = this.book;
		if (!book || !this.info?.sheets[this.sheet]) return;
		const scrollTop = this.scrollEl.scrollTop;
		const scrollLeft = this.scrollEl.scrollLeft;
		const rowsShown = keep && this.grid ? this.grid.rows.length : 0;
		const sel = keep ? this.sel : null;
		const anchor = keep ? this.anchor : null;
		this.editor = null;
		this.scrollEl.empty();
		this.grid = null;
		this.nextRow = null;
		this.selTd = null;
		this.inRange = [];
		this.chartLayer = null;
		this.setNotice(this.info.warnings ?? []);
		try {
			const first = this.fetch(0, Math.max(BLOCK_ROWS, rowsShown));
			if (!first) return;
			this.grid = new Grid(this.scrollEl, first, { headers: true, rowHeights: true, resizable: true });
			this.nextRow = first.nextRow;
			while (this.nextRow !== null && this.grid.rows.length < rowsShown) {
				const more = this.fetch(this.nextRow, rowsShown - this.grid.rows.length);
				if (!more) break;
				this.grid.append(more);
				this.nextRow = more.nextRow;
			}
			if (first.moreCols) this.setNotice([...(this.info.warnings ?? []), `Showing the first ${first.cols.length} columns.`]);
			this.applyFreeze();
			this.drawCharts();
			if (keep) {
				this.scrollEl.scrollTop = scrollTop;
				this.scrollEl.scrollLeft = scrollLeft;
			}
			const cols = this.grid.columns;
			if (sel) {
				if (anchor) this.select(anchor.r, anchor.c, false);
				this.select(sel.r, sel.c, false, !!anchor);
			} else if (this.grid.rows.length && cols.length) this.select(this.grid.rows[0], cols[0], false);
			this.maybeFetchMore();
		} catch (e) {
			this.message(`GridCraft couldn't show this sheet.\n\n${errorText(e)}`, true);
		}
		this.updateUndoButtons();
	}

	/** Up to `rows` rows from `fromRow` (0-based) to the end of the shown extent. */
	private fetch(fromRow: number, rows = BLOCK_ROWS): RenderData | null {
		if (!this.book) return null;
		const { endRow, endCol } = this.extent();
		if (fromRow > endRow) return null;
		const range = `A${fromRow + 1}:${colLetters(endCol)}${endRow + 1}`;
		return JSON.parse(this.book.render(this.sheet, range, rows, 0)) as RenderData;
	}

	/** Adds the next block of rows when the bottom is near (or the sheet doesn't fill the view yet). */
	private maybeFetchMore(force = false) {
		if (this.fetching || !this.grid || this.nextRow === null) return;
		const el = this.scrollEl;
		if (!force && el.scrollTop + el.clientHeight < el.scrollHeight - 800) return;
		this.fetching = true;
		try {
			const data = this.fetch(this.nextRow);
			if (data) {
				this.grid.append(data);
				this.nextRow = data.nextRow;
			} else {
				this.nextRow = null;
			}
		} catch (e) {
			this.nextRow = null;
			this.setNotice([`Couldn't load more rows: ${errorText(e)}`]);
		} finally {
			this.fetching = false;
		}
		if (!force && this.nextRow !== null && el.scrollHeight <= el.clientHeight + 800) window.setTimeout(() => this.maybeFetchMore(), 0);
	}

	// ----- selection -----

	private a1(p: Pos): string {
		return `${colLetters(p.c)}${p.r + 1}`;
	}

	/** Selects a cell; with `extend`, the range from the anchor to it (the anchor stays). */
	private select(r: number, c: number, scroll = true, extend = false) {
		if (!this.grid || !this.book) return;
		const td = this.grid.cell(r, c);
		if (!td) return;
		this.selTd?.removeClass("gc-sel");
		this.sel = { r, c };
		if (!extend || !this.anchor) this.anchor = { r, c };
		this.selTd = td;
		td.addClass("gc-sel");
		this.paintRange();
		this.nameEl.setText(this.rangeA1());
		try {
			this.formulaEl.value = this.book.editText(this.sheet, this.a1(this.sel));
		} catch {
			this.formulaEl.value = "";
		}
		this.ribbon.update(this.currentFormat());
		if (scroll) td.scrollIntoView({ block: "nearest", inline: "nearest" });
	}

	/** The selected rectangle in sheet rows and columns. */
	private rect(): { r0: number; r1: number; c0: number; c1: number } | null {
		const a = this.anchor ?? this.sel;
		const b = this.sel;
		if (!a || !b) return null;
		return { r0: Math.min(a.r, b.r), r1: Math.max(a.r, b.r), c0: Math.min(a.c, b.c), c1: Math.max(a.c, b.c) };
	}

	private rangeA1(): string {
		const r = this.rect();
		if (!r) return "";
		const tl = this.a1({ r: r.r0, c: r.c0 });
		return r.r0 === r.r1 && r.c0 === r.c1 ? tl : `${tl}:${this.a1({ r: r.r1, c: r.c1 })}`;
	}

	private paintRange() {
		for (const td of this.inRange) td.removeClass("gc-inrange");
		this.inRange = [];
		const r = this.rect();
		const grid = this.grid;
		if (!r || !grid || (r.r0 === r.r1 && r.c0 === r.c1)) return;
		for (const row of grid.rows) {
			if (row < r.r0 || row > r.r1) continue;
			for (const col of grid.columns) {
				if (col < r.c0 || col > r.c1) continue;
				const td = grid.cell(row, col);
				if (td) {
					td.addClass("gc-inrange");
					this.inRange.push(td);
				}
			}
		}
	}

	private currentFormat(): CellFormat | null {
		if (!this.sel) return null;
		const at = this.a1(this.sel);
		return this.parse<CellFormat>(() => this.book?.cellFormat(this.sheet, at));
	}

	/** Runs a GridCraft command on the selection (formatting, clearing, tables). */
	private runCommand(id: string, params: Record<string, unknown>, withRange: boolean) {
		if (!this.book || !this.sel) return;
		if (!this.commitEdit()) return;
		const lines = this.lines();
		// Column and row commands take whole columns ("B:D") and rows ("2:5"), not a range.
		if (/^home\.(autofitColumnWidth|columnWidth)$/.test(id) && params.cols === undefined && lines) params = { cols: lines.cols, ...params };
		if (/^home\.(autofitRowHeight|rowHeight)$/.test(id) && params.rows === undefined && lines) params = { rows: lines.rows, ...params };
		if (/^home\.(autofit|columnWidth|rowHeight)/.test(id)) withRange = false;
		const all = withRange ? { range: this.rangeA1(), ...params } : params;
		try {
			this.book.run(this.sheet, id, JSON.stringify(all));
		} catch (e) {
			new Notice(`GridCraft couldn't do that: ${errorText(e)}`);
			return;
		}
		this.afterEdit();
		this.scrollEl.focus({ preventScroll: true });
	}

	/** Moves the selection by whole cells, stepping over merges and loading rows as needed. */
	private move(dr: number, dc: number, extend = false) {
		const grid = this.grid;
		if (!grid || !this.sel) return;
		const rows = grid.rows;
		const cols = grid.columns;
		let ri = rows.indexOf(this.sel.r);
		let ci = cols.indexOf(this.sel.c);
		if (ri < 0 || ci < 0) return;
		const td = (extend ? null : this.selTd) as HTMLTableCellElement | null;
		const stepR = dr > 0 ? Math.max(1, td?.rowSpan ?? 1) : dr < 0 ? -1 : 0;
		const stepC = dc > 0 ? Math.max(1, td?.colSpan ?? 1) : dc < 0 ? -1 : 0;
		ri += stepR;
		ci += stepC;
		for (let guard = 0; guard < 500; guard++) {
			if (ri >= rows.length && this.nextRow !== null) this.maybeFetchMore(true);
			if (ri < 0 || ci < 0 || ri >= rows.length || ci >= cols.length) return;
			if (grid.cell(rows[ri], cols[ci])) {
				this.select(rows[ri], cols[ci], true, extend);
				return;
			}
			ri += Math.sign(stepR);
			ci += Math.sign(stepC);
			if (stepR === 0 && stepC === 0) return;
		}
	}

	private cellAt(target: EventTarget | null): Pos | null {
		const td = (target as HTMLElement | null)?.closest?.("td");
		if (!td || !(td instanceof HTMLElement) || td.dataset.r === undefined || td.dataset.c === undefined) return null;
		return { r: Number(td.dataset.r), c: Number(td.dataset.c) };
	}

	/** Keeps the sheet's frozen rows and columns in place while the rest scrolls. */
	private applyFreeze() {
		const f = this.info?.sheets[this.sheet]?.freeze;
		this.grid?.freeze(f?.[0] ?? 0, f?.[1] ?? 0);
	}

	// ----- charts -----

	private chartList(): ChartInfo[] {
		return this.parse<ChartInfo[]>(() => this.book?.charts(this.sheet)) ?? [];
	}

	/** Draws the sheet's charts over the grid, where they sit in the workbook. */
	private drawCharts() {
		const grid = this.grid;
		if (!grid) return;
		const charts = this.chartList();
		if (charts.length === 0) {
			this.chartSel = null;
			return;
		}
		const head = grid.table.querySelector("thead") as HTMLElement | null;
		const origin = { left: grid.table.offsetLeft + 48, top: grid.table.offsetTop + (head?.offsetHeight ?? 0) };
		this.chartLayer = new ChartLayer(this.scrollEl, origin, charts, {
			interactive: true,
			onPlace: (id, left, top, width, height) => {
				if (!this.book) return;
				try {
					this.book.placeChart(this.sheet, id, left, top, width, height);
				} catch (e) {
					new Notice(`GridCraft couldn't move the chart: ${errorText(e)}`);
				}
				this.afterEdit();
			},
			onSelect: (chart) => {
				this.chartSel = chart?.id ?? null;
				if (chart) {
					this.commitEdit();
					this.nameEl.setText(chart.name);
					this.scrollEl.focus({ preventScroll: true });
				} else if (this.sel) {
					this.nameEl.setText(this.rangeA1());
				}
			},
			toolbar: (bar, chart) => this.chartToolbar(bar, chart),
		});
		if (this.chartSel !== null) this.chartLayer.select(this.chartSel);
	}

	private chartCommand(id: string, params: Record<string, unknown>) {
		this.runCommand(id, params, false);
	}

	/** The small toolbar above a selected chart: type, title, legend, labels, gridlines, colours, delete. */
	private chartToolbar(bar: HTMLElement, chart: ChartInfo) {
		const button = (icon: string, label: string, onClick: (e: MouseEvent) => void, active = false) => {
			const b = bar.createDiv({ cls: "clickable-icon gc-rb", attr: { "aria-label": label } });
			setIcon(b, icon);
			if (!b.querySelector("svg")) b.createSpan({ cls: "gc-rb-text", text: label.split(" ")[0] });
			b.toggleClass("is-active", active);
			b.addEventListener("pointerdown", (e) => e.stopPropagation());
			b.addEventListener("mousedown", (e) => {
				e.preventDefault();
				e.stopPropagation();
			});
			b.addEventListener("click", (e) => {
				e.stopPropagation();
				onClick(e);
			});
			return b;
		};
		const set = (params: Record<string, unknown>) => this.chartCommand("chart.set", { chart: chart.id, ...params });
		button("bar-chart-2", "Chart type", (e) => {
			const m = new Menu();
			for (const [title, type, subtype] of CHART_TYPES) m.addItem((i) => i.setTitle(title).onClick(() => set(subtype ? { type, subtype } : { type })));
			m.showAtMouseEvent(e);
		});
		button("heading", "Chart title", () => {
			new PromptModal(this.app, "Chart title", "Title", "Leave empty for no title.", chart.title ?? "", "text", (title) => set({ title })).open();
		});
		button("list", "Legend", (e) => {
			const m = new Menu();
			for (const [title, legend] of [["None", "none"], ["Bottom", "bottom"], ["Top", "top"], ["Left", "left"], ["Right", "right"]]) {
				m.addItem((i) => i.setTitle(title).setChecked(chart.legend.toLowerCase() === legend).onClick(() => set({ legend })));
			}
			m.showAtMouseEvent(e);
		});
		button("tag", "Data labels", () => set({ dataLabels: !chart.dataLabels }), chart.dataLabels);
		button("grid", "Gridlines", () => set({ gridlines: !chart.gridlines }), chart.gridlines);
		button("palette", "Chart colours", (e) => {
			const m = new Menu();
			m.addItem((i) => i.setTitle("Colourful").onClick(() => this.chartCommand("chart.changeColors", { chart: chart.id, palette: "colorful" })));
			m.addItem((i) => i.setTitle("Monochrome").onClick(() => this.chartCommand("chart.changeColors", { chart: chart.id, palette: "monochrome" })));
			for (let k = 1; k <= 6; k++) {
				m.addItem((i) => i.setTitle(`Shades of accent ${k}`).onClick(() => this.chartCommand("chart.changeColors", { chart: chart.id, palette: `accent${k}` })));
			}
			m.showAtMouseEvent(e);
		});
		button("arrow-left-right", "Switch rows and columns", () => this.chartCommand("chart.switchRowColumn", { chart: chart.id }));
		button("database", "Select data", () => this.askChartData(chart.id));
		button("trash-2", "Delete chart", () => this.deleteChart(chart.id));
	}

	/** Asks for the cells a chart plots (on any sheet), then redraws the chart from them. */
	private askChartData(id: number) {
		new PromptModal(
			this.app,
			"Chart data",
			"Data range",
			"A range on any sheet, such as Data!A1:D20. Quote a sheet name with spaces: 'Q1 Sales'!A1:C9.",
			"",
			"text",
			(text) => {
				if (text) this.chartCommand("chart.selectData", { chart: id, range: text });
			},
		).open();
	}

	/** Asks for a range on any sheet; the chart it makes is placed here, as a column chart. */
	private askChartSource() {
		if (!this.book) return;
		new PromptModal(
			this.app,
			"Chart from another sheet",
			"Data range",
			"A range on any sheet, such as Data!A1:D20. The chart starts as a column chart; change its type from the chart bar.",
			"",
			"text",
			(text) => {
				if (text) this.insertChartFrom(text);
			},
		).open();
	}

	/**
	 * Inserts a chart whose data is on `source`'s sheet. The engine names a chart's series after the
	 * sheet it's built on, so it's made there, then moved to this sheet at the active cell.
	 */
	private insertChartFrom(source: string) {
		const book = this.book;
		if (!book || !this.commitEdit()) return;
		const { sheet, range } = splitSource(source);
		if (!range) return;
		const from = sheet === null ? this.sheet : book.sheetIndex(sheet);
		if (from < 0 || !this.info?.sheets[from]) {
			new Notice(`There's no sheet named ${sheet ?? ""}.`);
			return;
		}
		const here = this.sheet;
		const hereName = this.info?.sheets[here]?.name;
		const at = this.sel ? this.a1(this.sel) : "A1";
		let id: number;
		try {
			const made = JSON.parse(book.run(from, "insert.chart", JSON.stringify({ range, type: "column" }))) as { chart?: number };
			if (typeof made.chart !== "number") throw new Error("the chart wasn't made");
			id = made.chart;
			if (from !== here && hereName) book.run(from, "chart.move", JSON.stringify({ chart: id, sheet: hereName, at }));
		} catch (e) {
			new Notice(`GridCraft couldn't do that: ${errorText(e)}`);
			return;
		}
		this.chartSel = id;
		this.afterEdit();
		this.chartLayer?.select(id);
		this.scrollEl.querySelector(`.gc-chart[data-id="${id}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}

	private deleteChart(id: number) {
		this.chartSel = null;
		this.chartCommand("chart.delete", { chart: id });
	}

	/** Inserts a chart of the selected data, then selects it. */
	private insertChart(type: string, subtype?: string) {
		if (!this.book) return;
		const before = new Set(this.chartList().map((c) => c.id));
		this.runCommand("insert.chart", subtype ? { type, subtype } : { type }, true);
		const added = this.chartList().find((c) => !before.has(c.id));
		if (added) {
			this.chartSel = added.id;
			this.chartLayer?.select(added.id);
			const box = this.scrollEl.querySelector(`.gc-chart[data-id="${added.id}"]`);
			box?.scrollIntoView({ block: "nearest", inline: "nearest" });
		}
	}

	private onMouseDown(e: MouseEvent) {
		if (e.target === this.editor || e.button !== 0) return;
		const p = this.cellAt(e.target);
		if (!p) return;
		// Dragging selects cells (as in a spreadsheet), not text; Ctrl+C copies the cells.
		e.preventDefault();
		this.chartLayer?.select(null);
		this.commitEdit();
		this.select(p.r, p.c, false, e.shiftKey);
		this.dragging = true;
		this.scrollEl.focus({ preventScroll: true });
	}

	private onMouseOver(e: MouseEvent) {
		if (!this.dragging || (e.buttons & 1) === 0) {
			this.dragging = false;
			return;
		}
		const p = this.cellAt(e.target);
		if (p && (p.r !== this.sel?.r || p.c !== this.sel?.c)) this.select(p.r, p.c, false, true);
	}

	/** The selected columns and rows as "B:D" and "2:5". */
	private lines(): { cols: string; rows: string } | null {
		const r = this.rect();
		if (!r) return null;
		return { cols: `${colLetters(r.c0)}:${colLetters(r.c1)}`, rows: `${r.r0 + 1}:${r.r1 + 1}` };
	}

	/**
	 * Dragging the edge of a column letter or row number resizes it (all the selected columns or
	 * rows, when it's one of them); double-clicking the edge fits it to its contents.
	 */
	private onResizeStart(e: PointerEvent) {
		const handle = e.target as HTMLElement;
		const isCol = handle.hasClass?.("gc-col-resize");
		const isRow = handle.hasClass?.("gc-row-resize");
		const grid = this.grid;
		if ((!isCol && !isRow) || !grid || e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		this.commitEdit();
		const index = Number(isCol ? handle.dataset.c : handle.dataset.r);
		const start = isCol ? e.clientX : e.clientY;
		const size0 = isCol ? grid.colWidth(index) : grid.rowHeight(index);
		let size = size0;
		handle.addClass("is-dragging");
		handle.setPointerCapture(e.pointerId);
		const move = (ev: PointerEvent) => {
			size = Math.max(isCol ? 8 : 6, size0 + (isCol ? ev.clientX : ev.clientY) - start);
			if (isCol) grid.setColWidth(index, size);
			else grid.setRowHeight(index, size);
			this.applyFreeze();
		};
		const up = () => {
			handle.removeEventListener("pointermove", move);
			handle.removeEventListener("pointerup", up);
			handle.removeEventListener("pointercancel", up);
			handle.removeClass("is-dragging");
			if (Math.abs(size - size0) < 1) return;
			const r = this.rect();
			const inSel = r && (isCol ? index >= r.c0 && index <= r.c1 && r.c1 > r.c0 : index >= r.r0 && index <= r.r1 && r.r1 > r.r0);
			if (isCol) {
				const cols = inSel && r ? `${colLetters(r.c0)}:${colLetters(r.c1)}` : `${colLetters(index)}:${colLetters(index)}`;
				this.runCommand("home.columnWidth", { cols, width: Math.round(size) }, false);
			} else {
				const rows = inSel && r ? `${r.r0 + 1}:${r.r1 + 1}` : `${index + 1}:${index + 1}`;
				this.runCommand("home.rowHeight", { rows, height: Math.round(size) }, false);
			}
		};
		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", up);
		handle.addEventListener("pointercancel", up);
	}

	/** Asks for an exact column width or row height for the selection, then applies it. */
	private askSize(what: "width" | "height") {
		const grid = this.grid;
		const lines = this.lines();
		const r = this.rect();
		if (!grid || !lines || !r) return;
		const current = what === "width" ? grid.colWidth(r.c0) : grid.rowHeight(r.r0);
		const label = what === "width" ? `Column width for ${lines.cols}` : `Row height for ${lines.rows}`;
		new PromptModal(this.app, label, "Pixels", "Default column width is 64, default row height is 20.", String(Math.round(current)), "number", (text) => {
			const px = Number(text);
			if (!Number.isFinite(px) || px < 0 || px > 2000) {
				new Notice("Enter a size from 0 to 2000 pixels.");
				return;
			}
			if (what === "width") this.runCommand("home.columnWidth", { cols: lines.cols, width: Math.round(px) }, false);
			else this.runCommand("home.rowHeight", { rows: lines.rows, height: Math.round(px) }, false);
		}).open();
	}

	private onDoubleClick(e: MouseEvent) {
		const handle = e.target as HTMLElement;
		if (handle.hasClass?.("gc-col-resize") || handle.hasClass?.("gc-row-resize")) {
			e.preventDefault();
			const isCol = handle.hasClass("gc-col-resize");
			const index = Number(isCol ? handle.dataset.c : handle.dataset.r);
			const r = this.rect();
			const inSel = r && (isCol ? index >= r.c0 && index <= r.c1 : index >= r.r0 && index <= r.r1);
			if (isCol) this.runCommand("home.autofitColumnWidth", { cols: inSel && r ? `${colLetters(r.c0)}:${colLetters(r.c1)}` : `${colLetters(index)}:${colLetters(index)}` }, false);
			else this.runCommand("home.autofitRowHeight", { rows: inSel && r ? `${r.r0 + 1}:${r.r1 + 1}` : `${index + 1}:${index + 1}` }, false);
			return;
		}
		const p = this.cellAt(e.target);
		if (!p) return;
		e.preventDefault();
		this.select(p.r, p.c, false);
		this.startEdit();
	}

	// ----- keyboard -----

	private onGridKey(e: KeyboardEvent) {
		if (this.editor || !this.sel || !this.book) return;
		const chart = this.chartLayer?.selected;
		if (chart) {
			const mod = Platform.isMacOS ? e.metaKey : e.ctrlKey;
			if (e.key === "Delete" || e.key === "Backspace") this.deleteChart(chart.id);
			else if (e.key === "Escape") this.chartLayer?.select(null);
			else if (mod && e.key.toLowerCase() === "z") this.undoRedo(e.shiftKey);
			else if (mod && e.key.toLowerCase() === "y") this.undoRedo(true);
			else return;
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		const mod = Platform.isMacOS ? e.metaKey : e.ctrlKey;
		const key = e.key;
		let handled = true;
		if (mod && !e.altKey) {
			const k = key.toLowerCase();
			if (k === "z" && !e.shiftKey) this.undoRedo(false);
			else if (k === "b") this.runToggle("bold", "home.bold");
			else if (k === "i") this.runToggle("italic", "home.italic");
			else if (k === "u") this.runToggle("underline", "home.underline");
			else if (k === "y" || (k === "z" && e.shiftKey)) this.undoRedo(true);
			else if (k === "s") void this.saveNow();
			else handled = false;
		} else if (key === "ArrowDown") this.move(1, 0, e.shiftKey);
		else if (key === "ArrowUp") this.move(-1, 0, e.shiftKey);
		else if (key === "ArrowRight") this.move(0, 1, e.shiftKey);
		else if (key === "ArrowLeft") this.move(0, -1, e.shiftKey);
		else if (key === "Enter") this.move(e.shiftKey ? -1 : 1, 0);
		else if (key === "Tab") this.move(0, e.shiftKey ? -1 : 1);
		else if (key === "F2") this.startEdit();
		else if (key === "Delete" || key === "Backspace") {
			if (this.rangeA1().includes(":")) this.runCommand("edit.clearContents", {}, true);
			else this.setCell(this.sel, "");
		}
		else if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) this.startEdit(key);
		else handled = false;
		if (handled) {
			e.preventDefault();
			e.stopPropagation();
		}
	}

	/** Copies the selected cells as tab-separated text, as a spreadsheet does. */
	private onCopy(e: ClipboardEvent) {
		const r = this.rect();
		const grid = this.grid;
		if (this.editor || !r || !grid) return;
		const lines: string[] = [];
		for (const row of grid.rows) {
			if (row < r.r0 || row > r.r1) continue;
			const cells: string[] = [];
			for (const col of grid.columns) {
				if (col < r.c0 || col > r.c1) continue;
				const t = grid.cell(row, col)?.textContent ?? "";
				cells.push(/[\t\n"]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
			}
			lines.push(cells.join("\t"));
		}
		e.clipboardData?.setData("text/plain", lines.join("\n"));
		e.preventDefault();
	}

	private runToggle(key: "bold" | "italic" | "underline", id: string) {
		const f = this.currentFormat();
		this.runCommand(id, { on: !(f?.[key] ?? false) }, true);
	}

	/** Pastes text into the selected cell; tab-separated lines fill a block, as in a spreadsheet. */
	private onPaste(e: ClipboardEvent) {
		if (this.editor || !this.sel || !this.book) return;
		const text = e.clipboardData?.getData("text/plain");
		if (text === undefined) return;
		e.preventDefault();
		const lines = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
		const grid = lines.map((l) => l.split("\t"));
		const cells = grid.reduce((n, r) => n + r.length, 0);
		if (cells > 10_000) {
			new Notice("That's too much to paste at once (over 10,000 cells).");
			return;
		}
		const r = this.rect();
		const start = r ? { r: r.r0, c: r.c0 } : this.sel;
		try {
			grid.forEach((row, i) =>
				row.forEach((value, j) => {
					this.book?.setCell(this.sheet, `${colLetters(start.c + j)}${start.r + i + 1}`, value);
				}),
			);
		} catch (err) {
			new Notice(`Couldn't paste: ${errorText(err)}`);
		}
		this.afterEdit();
	}

	// ----- editing -----

	private startEdit(initial?: string) {
		if (!this.sel || !this.selTd || !this.book) return;
		this.commitEdit();
		const td = this.selTd;
		let text = initial;
		if (text === undefined) {
			try {
				text = this.book.editText(this.sheet, this.a1(this.sel));
			} catch {
				text = "";
			}
		}
		const host = this.scrollEl.getBoundingClientRect();
		const rect = td.getBoundingClientRect();
		const input = this.scrollEl.createEl("input", { cls: "gc-editor", attr: { type: "text", spellcheck: "false" } });
		input.style.left = `${rect.left - host.left + this.scrollEl.scrollLeft}px`;
		input.style.top = `${rect.top - host.top + this.scrollEl.scrollTop}px`;
		input.style.minWidth = `${Math.max(rect.width, 60)}px`;
		input.style.height = `${Math.max(rect.height, 22)}px`;
		input.value = text;
		this.editor = input;
		const at = { ...this.sel };
		input.addEventListener("input", () => (this.formulaEl.value = input.value));
		input.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Enter") {
				e.preventDefault();
				if (this.commitEdit()) this.move(e.shiftKey ? -1 : 1, 0);
				this.scrollEl.focus({ preventScroll: true });
			} else if (e.key === "Tab") {
				e.preventDefault();
				if (this.commitEdit()) this.move(0, e.shiftKey ? -1 : 1);
				this.scrollEl.focus({ preventScroll: true });
			} else if (e.key === "Escape") {
				e.preventDefault();
				this.cancelEdit();
				this.scrollEl.focus({ preventScroll: true });
			}
		});
		input.addEventListener("blur", () => {
			if (this.editor === input && this.sel && this.sel.r === at.r && this.sel.c === at.c) this.commitEdit();
		});
		input.focus();
		input.setSelectionRange(input.value.length, input.value.length);
	}

	/** Enters what's in the cell editor; false (and the editor stays) if GridCraft refused it. */
	private commitEdit(): boolean {
		const input = this.editor;
		if (!input || !this.sel) return true;
		this.editor = null;
		const value = input.value;
		input.remove();
		return this.setCell(this.sel, value);
	}

	private cancelEdit() {
		const input = this.editor;
		// Cleared first: removing the input blurs it, and a blur with an editor open commits.
		this.editor = null;
		input?.remove();
		if (this.sel) this.select(this.sel.r, this.sel.c, false);
	}

	private onFormulaKey(e: KeyboardEvent) {
		e.stopPropagation();
		if (!this.sel) return;
		if (e.key === "Enter") {
			e.preventDefault();
			if (this.setCell(this.sel, this.formulaEl.value)) this.move(1, 0);
			this.scrollEl.focus({ preventScroll: true });
		} else if (e.key === "Escape") {
			e.preventDefault();
			this.select(this.sel.r, this.sel.c, false);
			this.scrollEl.focus({ preventScroll: true });
		}
	}

	/** Enters `input` at `p` (as typed: number, text, date, =formula; empty clears). */
	private setCell(p: Pos, input: string): boolean {
		if (!this.book) return false;
		const a1 = this.a1(p);
		let before = "";
		try {
			before = this.book.editText(this.sheet, a1);
		} catch {
			// Fine: compare against empty.
		}
		if (before === input) return true;
		try {
			this.book.setCell(this.sheet, a1, input);
		} catch (e) {
			new Notice(`GridCraft didn't accept that: ${errorText(e)}`);
			return false;
		}
		if (input.startsWith("=") && this.file?.extension.toLowerCase() === "csv" && !this.csvFormulaWarned) {
			this.csvFormulaWarned = true;
			new Notice("CSV files keep values only: the formula's result is saved, not the formula. Save as .xlsx in GridCraft to keep formulas.", 8000);
		}
		this.afterEdit();
		return true;
	}

	private undoRedo(redo: boolean) {
		if (!this.book) return;
		this.commitEdit();
		try {
			const done = redo ? this.book.redo() : this.book.undo();
			if (done) this.afterEdit();
		} catch (e) {
			new Notice(`Couldn't ${redo ? "redo" : "undo"}: ${errorText(e)}`);
		}
	}

	/** After any change: refresh sheet info and the shown cells, then save shortly. */
	private afterEdit() {
		if (!this.book) return;
		try {
			this.info = JSON.parse(this.book.info()) as BookInfo;
		} catch {
			// Keep the old extent.
		}
		this.showSheet(true);
		this.setSaveState(this.book.isDirty() ? "edited" : "saved");
		this.scheduleSave();
	}

	private updateUndoButtons() {
		const book = this.book;
		this.undoEl.toggleClass("is-disabled", !book?.canUndo());
		this.redoEl.toggleClass("is-disabled", !book?.canRedo());
	}

	// ----- saving -----

	private scheduleSave() {
		this.cancelSave();
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.saveNow();
		}, SAVE_DELAY_MS);
	}

	private cancelSave() {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = null;
	}

	/** Writes the workbook to its file now, if it has unsaved edits. */
	async saveNow(file: TFile | null = this.file): Promise<void> {
		this.cancelSave();
		if (this.saving) await this.saving;
		const book = this.book;
		if (!file || !book || !book.isDirty()) return;
		this.saving = (async () => {
			this.setSaveState("saving");
			try {
				const bytes = book.save(file.name);
				const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
				this.plugin.noteOwnWrite(file.path, this);
				await this.app.vault.modifyBinary(file, data);
				this.setSaveState(book.isDirty() ? "edited" : "saved");
			} catch (e) {
				this.setSaveState("failed", errorText(e));
				new Notice(`GridCraft Viewer couldn't save ${file.name}: ${errorText(e)}`);
			}
		})();
		try {
			await this.saving;
		} finally {
			this.saving = null;
		}
	}

	private setSaveState(state: SaveState, detail = "") {
		const text = { saved: "Saved", edited: "Edited", saving: "Saving…", failed: "Not saved" }[state];
		this.stateEl.setText(text);
		this.stateEl.setAttr("aria-label", detail || text);
		this.stateEl.toggleClass("gc-failed", state === "failed");
		this.updateUndoButtons();
	}

	// ----- messages -----

	private setNotice(lines: string[]) {
		this.noticeEl.empty();
		if (lines.length === 0) {
			this.noticeEl.hide();
			return;
		}
		this.noticeEl.show();
		for (const l of lines) this.noticeEl.createDiv({ text: l });
	}

	private message(text: string, isError = false) {
		this.noticeEl?.hide();
		this.tabsEl?.hide();
		if (isError) this.barEl?.hide();
		this.scrollEl.empty();
		const box = this.scrollEl.createDiv({ cls: isError ? "gc-message gc-error" : "gc-message" });
		for (const para of text.split("\n\n")) box.createEl("p", { text: para });
	}
}

function statusText(s: EngineStatus): string {
	switch (s) {
		case "checking":
			return "Starting GridCraft…";
		case "downloading":
			return "Downloading the GridCraft engine (about 2.8 MB, one time only)…";
		case "starting":
			return "Starting GridCraft…";
	}
}

/** Asks for one value (a size, a title). */
class PromptModal extends Modal {
	constructor(
		app: App,
		private heading: string,
		private name: string,
		private desc: string,
		private value: string,
		private type: "number" | "text",
		private onSubmit: (value: string) => void,
	) {
		super(app);
	}

	override onOpen() {
		this.titleEl.setText(this.heading);
		let value = this.value;
		const submit = () => {
			this.close();
			this.onSubmit(value.trim());
		};
		new Setting(this.contentEl)
			.setName(this.name)
			.setDesc(this.desc)
			.addText((t) => {
				t.setValue(value).onChange((v) => (value = v));
				t.inputEl.type = this.type;
				t.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						submit();
					}
				});
				window.setTimeout(() => t.inputEl.select(), 0);
			});
		new Setting(this.contentEl).addButton((b) => b.setButtonText("OK").setCta().onClick(submit));
	}

	override onClose() {
		this.contentEl.empty();
	}
}
