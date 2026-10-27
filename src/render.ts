// Turns the engine's JSON for a block of cells into an HTML table. Shared by the tab view and
// (from v0.2) by embeds and code blocks in notes.

export interface RenderCell {
	/** Text as the cell shows it, number format applied. */
	t?: string;
	/** Index into RenderData.styles. */
	s?: number;
	/** Alignment of a General cell: right (numbers) or centre (booleans, errors). */
	a?: "r" | "c";
	/** Colour from the number format, such as [Red]. */
	fc?: string;
	cs?: number;
	rs?: number;
	/** Inside a merge: no cell of its own. */
	m?: 1;
	/** Conditional-format icon: glyph and colour. */
	ic?: [string, string];
}

export interface RenderData {
	sheet: number;
	name: string;
	range: string;
	nextRow: number | null;
	moreCols: boolean;
	cols: { i: number; l: string; w: number }[];
	rows: { i: number; h: number; c: (RenderCell | null)[] }[];
	styles: string[];
}

export interface GridOptions {
	/** Column letters and row numbers around the cells. */
	headers: boolean;
	/** Row heights from the workbook (the tab view); notes keep rows compact. */
	rowHeights: boolean;
	/** Drag handles on the column and row headers. */
	resizable?: boolean;
}

/** A table that more rows can be added to as they arrive. */
export class Grid {
	readonly table: HTMLTableElement;
	private body: HTMLTableSectionElement;
	private cols: RenderData["cols"];
	/** Sheet row indexes in the order they're shown. */
	readonly rows: number[] = [];
	private cells = new Map<string, HTMLTableCellElement>();
	private colEls = new Map<number, HTMLTableColElement>();
	private rowEls = new Map<number, HTMLTableRowElement>();

	constructor(parent: HTMLElement, first: RenderData, private opts: GridOptions) {
		this.cols = first.cols;
		this.table = parent.createEl("table", { cls: opts.headers ? "gc-grid" : "gc-grid gc-noheads" });
		const colgroup = this.table.createEl("colgroup");
		let width = 0;
		if (opts.headers) {
			colgroup.createEl("col", { cls: "gc-rowhead-col" }).style.width = "48px";
			width += 48;
		}
		for (const c of first.cols) {
			const w = Math.max(4, c.w);
			const col = colgroup.createEl("col");
			col.style.width = `${w}px`;
			this.colEls.set(c.i, col);
			width += w;
		}
		this.table.style.width = `${width}px`;
		if (opts.headers) {
			const tr = this.table.createEl("thead").createEl("tr");
			tr.createEl("th", { cls: "gc-corner" });
			for (const c of first.cols) {
				const th = tr.createEl("th", { cls: "gc-colhead", text: c.l });
				th.dataset.c = String(c.i);
				if (opts.resizable) th.createDiv({ cls: "gc-col-resize", attr: { "aria-label": "Drag to resize; double-click to fit" } }).dataset.c = String(c.i);
			}
		}
		this.body = this.table.createEl("tbody");
		this.append(first);
	}

	/** Adds the rows of another block with the same columns. */
	append(data: RenderData) {
		for (const row of data.rows) {
			const tr = this.body.createEl("tr");
			this.rows.push(row.i);
			this.rowEls.set(row.i, tr);
			if (this.opts.rowHeights) tr.style.height = `${Math.max(4, row.h)}px`;
			if (this.opts.headers) {
				const th = tr.createEl("th", { cls: "gc-rowhead", text: String(row.i + 1) });
				th.dataset.r = String(row.i);
				if (this.opts.resizable) th.createDiv({ cls: "gc-row-resize", attr: { "aria-label": "Drag to resize; double-click to fit" } }).dataset.r = String(row.i);
			}
			for (let k = 0; k < row.c.length; k++) {
				const cell = row.c[k];
				if (cell?.m) continue;
				const td = tr.createEl("td");
				const col = data.cols[k]?.i ?? k;
				td.dataset.r = String(row.i);
				td.dataset.c = String(col);
				this.cells.set(`${row.i}:${col}`, td);
				if (!cell) continue;
				if (cell.t) td.textContent = cell.t;
				if (cell.ic) {
					const icon = createSpan({ cls: "gc-icon", text: cell.ic[0] });
					icon.style.color = cell.ic[1];
					td.prepend(icon);
				}
				if (cell.s !== undefined) {
					const css = data.styles[cell.s];
					if (css) td.style.cssText = css;
				}
				if (cell.fc) td.style.color = cell.fc;
				if (cell.a === "r") td.addClass("gc-r");
				else if (cell.a === "c") td.addClass("gc-c");
				if (cell.cs && cell.cs > 1) td.colSpan = cell.cs;
				if (cell.rs && cell.rs > 1) td.rowSpan = cell.rs;
				// Left-aligned text runs on over empty cells to its right, as in Excel.
				if (cell.t && !cell.a && !cell.cs && row.c[k + 1] === null && !td.style.textAlign && td.style.whiteSpace !== "pre-wrap") {
					td.addClass("gc-spill");
				}
			}
		}
	}

	get columnCount(): number {
		return this.cols.length;
	}

	/** Shown width of sheet column `col` in px. */
	colWidth(col: number): number {
		return parseFloat(this.colEls.get(col)?.style.width ?? "") || 0;
	}

	/** Changes a column's shown width (while dragging); the table grows or shrinks with it. */
	setColWidth(col: number, px: number) {
		const el = this.colEls.get(col);
		if (!el) return;
		const before = this.colWidth(col);
		const w = Math.max(4, Math.round(px));
		el.style.width = `${w}px`;
		const total = parseFloat(this.table.style.width) || 0;
		this.table.style.width = `${total + w - before}px`;
	}

	/** The row's height as the workbook stores it (what a resize starts from). */
	rowHeight(row: number): number {
		const tr = this.rowEls.get(row);
		return parseFloat(tr?.style.height ?? "") || tr?.getBoundingClientRect().height || 0;
	}

	setRowHeight(row: number, px: number) {
		const tr = this.rowEls.get(row);
		if (tr) tr.style.height = `${Math.max(4, Math.round(px))}px`;
	}

	/** Sheet column indexes in the order they're shown. */
	get columns(): number[] {
		return this.cols.map((c) => c.i);
	}

	/** The table cell showing sheet cell (row, col), if it has one of its own (not inside a merge). */
	cell(row: number, col: number): HTMLTableCellElement | undefined {
		return this.cells.get(`${row}:${col}`);
	}
}

/** The cells' text, row by row (cells inside a merge are empty). */
export function cellTexts(data: RenderData): string[][] {
	return data.rows.map((row) => row.c.map((c) => (c && !c.m ? (c.t ?? "") : "")));
}

/** Tab-separated text, as a spreadsheet pastes it. */
export function toTsv(data: RenderData): string {
	const quote = (t: string) => (/[\t\n"]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
	return cellTexts(data)
		.map((r) => r.map(quote).join("\t"))
		.join("\n");
}

/** A Markdown table; the first row becomes the header row. */
export function toMarkdown(data: RenderData): string {
	const rows = cellTexts(data);
	if (rows.length === 0) return "";
	const esc = (t: string) => t.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
	const line = (r: string[]) => `| ${r.map(esc).join(" | ")} |`;
	const width = Math.max(...rows.map((r) => r.length));
	const pad = (r: string[]) => [...r, ...Array<string>(width - r.length).fill("")];
	const [head, ...rest] = rows.map(pad);
	return [line(head), `| ${Array<string>(width).fill("---").join(" | ")} |`, ...rest.map(line)].join("\n");
}

/** Column letters for a 0-based index (0 = A). */
export function colLetters(i: number): string {
	let n = i + 1;
	let s = "";
	while (n > 0) {
		const r = (n - 1) % 26;
		s = String.fromCharCode(65 + r) + s;
		n = Math.floor((n - 1) / 26);
	}
	return s;
}
