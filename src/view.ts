// The read-only tab a spreadsheet opens in: the sheet's cells, and sheet tabs along the bottom.

import { FileView, type TFile, type WorkspaceLeaf } from "obsidian";
import { errorText, type Book, type EngineStatus } from "./engine";
import type GridCraftPlugin from "./main";
import { colLetters, Grid, type RenderData } from "./render";

export const VIEW_TYPE = "gridcraft-sheet";
export const EXTENSIONS = ["xlsx", "csv"];

/** Rows fetched per block; more are fetched as you scroll near the bottom. */
const BLOCK_ROWS = 500;

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

export class SheetView extends FileView {
	private book: Book | null = null;
	private info: BookInfo | null = null;
	private sheet = 0;
	private grid: Grid | null = null;
	private nextRow: number | null = null;
	private fetching = false;
	private loadToken = 0;
	private bodyEl!: HTMLElement;
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

	override async onUnloadFile(_file: TFile): Promise<void> {
		this.loadToken++;
		this.freeBook();
		this.contentEl.empty();
	}

	override async onClose(): Promise<void> {
		this.freeBook();
	}

	/** Re-reads the file (after it changed on disk or arrived through sync), keeping the sheet. */
	async reload() {
		if (!this.file) return;
		const keep = this.info?.sheets[this.sheet]?.name;
		this.buildLayout();
		await this.loadBook(this.file, keep);
	}

	private buildLayout() {
		this.contentEl.empty();
		this.contentEl.addClass("gc-view");
		this.bodyEl = this.contentEl.createDiv({ cls: "gc-body" });
		this.noticeEl = this.bodyEl.createDiv({ cls: "gc-notice" });
		this.noticeEl.hide();
		this.scrollEl = this.bodyEl.createDiv({ cls: "gc-scroll" });
		this.tabsEl = this.contentEl.createDiv({ cls: "gc-tabs" });
		this.registerDomEvent(this.scrollEl, "scroll", () => this.maybeFetchMore());
	}

	private async loadBook(file: TFile, sheetName?: string) {
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
			this.renderTabs();
			this.showSheet();
		} catch (e) {
			if (token !== this.loadToken) return;
			this.message(`GridCraft couldn't open ${file.name}.\n\n${errorText(e)}`, true);
		}
	}

	private freeBook() {
		this.grid = null;
		this.nextRow = null;
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
				this.sheet = i;
				this.renderTabs();
				this.showSheet();
			});
		});
	}

	private showSheet() {
		const book = this.book;
		const info = this.info?.sheets[this.sheet];
		if (!book || !info) return;
		this.scrollEl.empty();
		this.scrollEl.scrollTop = 0;
		this.scrollEl.scrollLeft = 0;
		this.grid = null;
		this.nextRow = null;
		this.setNotice(this.info?.warnings ?? []);
		if (info.lastRow === null || info.lastCol === null) {
			this.scrollEl.createDiv({ cls: "gc-empty", text: "This sheet is empty." });
			return;
		}
		try {
			const data = this.fetch(0);
			if (!data) return;
			this.grid = new Grid(this.scrollEl, data, { headers: true });
			this.nextRow = data.nextRow;
			if (data.moreCols) {
				this.setNotice([...(this.info?.warnings ?? []), `Showing the first ${data.cols.length} columns.`]);
			}
			this.maybeFetchMore();
		} catch (e) {
			this.message(`GridCraft couldn't show this sheet.\n\n${errorText(e)}`, true);
		}
	}

	/** One block of rows from `fromRow` (0-based) to the end of the used range. */
	private fetch(fromRow: number): RenderData | null {
		const info = this.info?.sheets[this.sheet];
		if (!this.book || !info || info.lastRow === null || info.lastCol === null) return null;
		const range = `A${fromRow + 1}:${colLetters(info.lastCol)}${info.lastRow + 1}`;
		return JSON.parse(this.book.render(this.sheet, range, BLOCK_ROWS, 0)) as RenderData;
	}

	/** Adds the next block of rows when the bottom is near (or the sheet doesn't fill the view yet). */
	private maybeFetchMore() {
		if (this.fetching || !this.grid || this.nextRow === null) return;
		const el = this.scrollEl;
		if (el.scrollTop + el.clientHeight < el.scrollHeight - 800) return;
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
		// Keep going while the view still isn't full.
		if (this.nextRow !== null && el.scrollHeight <= el.clientHeight + 800) window.setTimeout(() => this.maybeFetchMore(), 0);
	}

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
			return "Downloading the GridCraft engine (about 3 MB, one time only)…";
		case "starting":
			return "Starting GridCraft…";
	}
}
