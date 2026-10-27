// The tab a spreadsheet opens in: a formula bar, the sheet's cells, and sheet tabs along the
// bottom. Cells are edited through GridCraft's engine (its undo history and recalculation) and
// the file is saved back to the vault a moment after each change.

import { FileView, Notice, Platform, setIcon, type TFile, type WorkspaceLeaf } from "obsidian";
import { errorText, type Book, type EngineStatus } from "./engine";
import type GridCraftPlugin from "./main";
import { colLetters, Grid, type RenderData } from "./render";

export const VIEW_TYPE = "gridcraft-sheet";
export const EXTENSIONS = ["xlsx", "csv"];

/** Rows fetched per block; more are fetched as you scroll near the bottom. */
const BLOCK_ROWS = 500;
/** Empty rows and columns shown past the used range, to type into. */
const PAD_ROWS = 50;
const PAD_COLS = 6;
const MAX_ROW = 1_048_575;
const MAX_COL = 16_383;
/** Saved this long after the last edit. */
const SAVE_DELAY_MS = 1200;

interface SheetInfo {
	name: string;
	hidden: boolean;
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

	private sel: Pos | null = null;
	private selTd: HTMLElement | null = null;
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
		this.barEl.hide();

		const body = this.contentEl.createDiv({ cls: "gc-body" });
		this.noticeEl = body.createDiv({ cls: "gc-notice" });
		this.noticeEl.hide();
		this.scrollEl = body.createDiv({ cls: "gc-scroll", attr: { tabindex: "0" } });
		this.tabsEl = this.contentEl.createDiv({ cls: "gc-tabs" });

		this.registerDomEvent(this.scrollEl, "scroll", () => this.maybeFetchMore());
		this.registerDomEvent(this.scrollEl, "mousedown", (e) => this.onMouseDown(e));
		this.registerDomEvent(this.scrollEl, "dblclick", (e) => this.onDoubleClick(e));
		this.registerDomEvent(this.scrollEl, "keydown", (e) => this.onGridKey(e));
		this.registerDomEvent(this.scrollEl, "copy", (e) => this.onCopy(e));
		this.registerDomEvent(this.scrollEl, "paste", (e) => this.onPaste(e));
		this.registerDomEvent(this.formulaEl, "keydown", (e) => this.onFormulaKey(e));
		this.registerDomEvent(this.undoEl, "click", () => this.undoRedo(false));
		this.registerDomEvent(this.redoEl, "click", () => this.undoRedo(true));
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
		this.selTd = null;
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
		this.editor = null;
		this.scrollEl.empty();
		this.grid = null;
		this.nextRow = null;
		this.selTd = null;
		this.setNotice(this.info.warnings ?? []);
		try {
			const first = this.fetch(0, Math.max(BLOCK_ROWS, rowsShown));
			if (!first) return;
			this.grid = new Grid(this.scrollEl, first, { headers: true, rowHeights: true });
			this.nextRow = first.nextRow;
			while (this.nextRow !== null && this.grid.rows.length < rowsShown) {
				const more = this.fetch(this.nextRow, rowsShown - this.grid.rows.length);
				if (!more) break;
				this.grid.append(more);
				this.nextRow = more.nextRow;
			}
			if (first.moreCols) this.setNotice([...(this.info.warnings ?? []), `Showing the first ${first.cols.length} columns.`]);
			if (keep) {
				this.scrollEl.scrollTop = scrollTop;
				this.scrollEl.scrollLeft = scrollLeft;
			}
			const cols = this.grid.columns;
			if (sel) this.select(sel.r, sel.c, false);
			else if (this.grid.rows.length && cols.length) this.select(this.grid.rows[0], cols[0], false);
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

	private select(r: number, c: number, scroll = true) {
		if (!this.grid || !this.book) return;
		const td = this.grid.cell(r, c);
		if (!td) return;
		this.selTd?.removeClass("gc-sel");
		this.sel = { r, c };
		this.selTd = td;
		td.addClass("gc-sel");
		this.nameEl.setText(this.a1(this.sel));
		try {
			this.formulaEl.value = this.book.editText(this.sheet, this.a1(this.sel));
		} catch {
			this.formulaEl.value = "";
		}
		if (scroll) td.scrollIntoView({ block: "nearest", inline: "nearest" });
	}

	/** Moves the selection by whole cells, stepping over merges and loading rows as needed. */
	private move(dr: number, dc: number) {
		const grid = this.grid;
		if (!grid || !this.sel) return;
		const rows = grid.rows;
		const cols = grid.columns;
		let ri = rows.indexOf(this.sel.r);
		let ci = cols.indexOf(this.sel.c);
		if (ri < 0 || ci < 0) return;
		const td = this.selTd as HTMLTableCellElement | null;
		const stepR = dr > 0 ? Math.max(1, td?.rowSpan ?? 1) : dr < 0 ? -1 : 0;
		const stepC = dc > 0 ? Math.max(1, td?.colSpan ?? 1) : dc < 0 ? -1 : 0;
		ri += stepR;
		ci += stepC;
		for (let guard = 0; guard < 500; guard++) {
			if (ri >= rows.length && this.nextRow !== null) this.maybeFetchMore(true);
			if (ri < 0 || ci < 0 || ri >= rows.length || ci >= cols.length) return;
			if (grid.cell(rows[ri], cols[ci])) {
				this.select(rows[ri], cols[ci]);
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

	private onMouseDown(e: MouseEvent) {
		if (e.target === this.editor) return;
		const p = this.cellAt(e.target);
		if (!p) return;
		this.commitEdit();
		this.select(p.r, p.c, false);
		// The grid (tabindex 0) takes keyboard focus from the click itself.
	}

	private onDoubleClick(e: MouseEvent) {
		const p = this.cellAt(e.target);
		if (!p) return;
		e.preventDefault();
		this.select(p.r, p.c, false);
		this.startEdit();
	}

	// ----- keyboard -----

	private onGridKey(e: KeyboardEvent) {
		if (this.editor || !this.sel || !this.book) return;
		const mod = Platform.isMacOS ? e.metaKey : e.ctrlKey;
		const key = e.key;
		let handled = true;
		if (mod && !e.altKey) {
			const k = key.toLowerCase();
			if (k === "z" && !e.shiftKey) this.undoRedo(false);
			else if (k === "y" || (k === "z" && e.shiftKey)) this.undoRedo(true);
			else if (k === "s") void this.saveNow();
			else handled = false;
		} else if (key === "ArrowDown") this.move(1, 0);
		else if (key === "ArrowUp") this.move(-1, 0);
		else if (key === "ArrowRight") this.move(0, 1);
		else if (key === "ArrowLeft") this.move(0, -1);
		else if (key === "Enter") this.move(e.shiftKey ? -1 : 1, 0);
		else if (key === "Tab") this.move(0, e.shiftKey ? -1 : 1);
		else if (key === "F2") this.startEdit();
		else if (key === "Delete" || key === "Backspace") this.setCell(this.sel, "");
		else if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) this.startEdit(key);
		else handled = false;
		if (handled) {
			e.preventDefault();
			e.stopPropagation();
		}
	}

	private onCopy(e: ClipboardEvent) {
		if (this.editor || !this.selTd) return;
		const selection = window.getSelection();
		if (selection && !selection.isCollapsed) return; // copying selected text: let the browser do it
		e.clipboardData?.setData("text/plain", this.selTd.textContent ?? "");
		e.preventDefault();
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
		const start = this.sel;
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
