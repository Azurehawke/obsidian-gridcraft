// Sheets inside notes: `![[Budget.xlsx]]`, `![[Budget.xlsx#Sheet1!A1:D20]]`, and the `gridcraft`
// code block. Both show the same read-only table with a small header (file name, sheet, copy).

import { Component, Keymap, Menu, Notice, setIcon, type TFile } from "obsidian";
import { errorText, type EngineStatus } from "./engine";
import type GridCraftPlugin from "./main";
import { colLetters, Grid, toMarkdown, toTsv, type RenderData } from "./render";

/** Rows shown when no range is given; give a range to show a different block. */
const EMBED_ROWS = 200;
/** Most rows an explicit range shows in a note. */
const EMBED_MAX_ROWS = 2000;

export interface SheetTarget {
	sheet?: string;
	range?: string;
	headers?: boolean;
}

const A1_RANGE = /^\$?[A-Za-z]{1,3}\$?\d+(:\$?[A-Za-z]{1,3}\$?\d+)?$|^\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}$|^\$?\d+:\$?\d+$/;

/**
 * Reads the part of a link after `#`: `Sheet1!A1:D20`, `'Q1 Sales'!B2:F9`, `Sheet1` or `A1:D20`.
 * A lone `A1:D20` means that range on the workbook's active sheet.
 */
export function parseSubpath(subpath: string | undefined): SheetTarget {
	let s = (subpath ?? "").replace(/^#+/, "").trim();
	try {
		s = decodeURIComponent(s);
	} catch {
		// Not URL-encoded; use as written.
	}
	if (!s) return {};
	const bang = s.lastIndexOf("!");
	if (bang >= 0) {
		const sheet = s.slice(0, bang).trim().replace(/^'(.*)'$/, "$1").replace(/''/g, "'");
		const range = s.slice(bang + 1).trim();
		return { sheet: sheet || undefined, range: range || undefined };
	}
	return A1_RANGE.test(s) ? { range: s } : { sheet: s };
}

/** One sheet table in a note. Re-renders when its file changes. */
export class SheetBlock extends Component {
	private started = false;
	private token = 0;
	private data: RenderData | null = null;

	constructor(
		private plugin: GridCraftPlugin,
		readonly containerEl: HTMLElement,
		readonly file: TFile,
		private target: SheetTarget,
	) {
		super();
	}

	/** Called by Obsidian's embed system once the embed is placed. */
	async loadFile(): Promise<void> {
		if (this.started) return;
		this.started = true;
		this.plugin.blocks.add(this);
		await this.render();
	}

	override onload() {
		void this.loadFile();
	}

	override onunload() {
		this.token++;
		this.plugin.blocks.delete(this);
	}

	async render(): Promise<void> {
		const token = ++this.token;
		const el = this.containerEl;
		el.empty();
		el.addClass("gc-embed");
		// Clicks and selections inside the table stay in the table instead of opening the
		// embed's source in Live Preview.
		el.onmousedown = (e) => e.stopPropagation();

		const head = el.createDiv({ cls: "gc-embed-head" });
		const title = head.createEl("a", { cls: "gc-embed-title", text: this.file.name, href: "#" });
		title.addEventListener("click", (e) => {
			e.preventDefault();
			void this.plugin.app.workspace.getLeaf(Keymap.isModEvent(e)).openFile(this.file);
		});
		const where = head.createSpan({ cls: "gc-embed-where" });
		const copy = head.createDiv({ cls: "clickable-icon gc-embed-copy", attr: { "aria-label": "Copy table" } });
		setIcon(copy, "copy");
		copy.addEventListener("click", (e) => this.copyMenu(e));

		const body = el.createDiv({ cls: "gc-embed-body" });
		const say = (text: string, error = false) => {
			body.empty();
			body.createDiv({ cls: error ? "gc-embed-msg gc-error" : "gc-embed-msg", text });
		};
		say("Loading…");

		try {
			const Book = await this.plugin.engine.get((s) => {
				if (token === this.token) say(statusText(s));
			});
			const bytes = await this.plugin.app.vault.readBinary(this.file);
			if (token !== this.token) return;
			const book = Book.open(this.file.name, new Uint8Array(bytes));
			let data: RenderData | null = null;
			let sheetName = "";
			try {
				const info = JSON.parse(book.info()) as {
					sheets: { name: string; hidden: boolean; lastRow: number | null; lastCol: number | null }[];
					active: number;
				};
				let index: number;
				if (this.target.sheet) {
					index = book.sheetIndex(this.target.sheet);
					if (index < 0) {
						const names = info.sheets.filter((s) => !s.hidden).map((s) => s.name);
						throw new Error(`There's no sheet named "${this.target.sheet}". Sheets: ${names.join(", ")}.`);
					}
				} else {
					const active = info.sheets[info.active];
					index = active && !active.hidden ? info.active : Math.max(0, info.sheets.findIndex((s) => !s.hidden));
				}
				const sheet = info.sheets[index];
				sheetName = sheet?.name ?? "";
				let range = this.target.range;
				if (!range && sheet && sheet.lastRow !== null && sheet.lastCol !== null) {
					range = `A1:${colLetters(sheet.lastCol)}${sheet.lastRow + 1}`;
				}
				if (range) {
					const limit = this.target.range ? EMBED_MAX_ROWS : EMBED_ROWS;
					data = JSON.parse(book.render(index, range, limit, 0)) as RenderData;
				}
			} finally {
				book.free();
			}
			if (token !== this.token) return;

			const multi = this.target.sheet || this.target.range;
			where.setText(multi ? [sheetName, this.target.range?.toUpperCase()].filter(Boolean).join(" › ") : sheetName);
			this.data = data;
			body.empty();
			if (!data || data.rows.length === 0) {
				say("This sheet is empty.");
				return;
			}
			new Grid(body, data, { headers: this.target.headers ?? false, rowHeights: false });
			const notes: string[] = [];
			if (data.nextRow !== null) notes.push(`Showing the first ${data.rows.length} rows. Open the file to see the rest, or link a range such as #${sheetName}!A1:F50.`);
			if (data.moreCols) notes.push(`Showing the first ${data.cols.length} columns.`);
			if (notes.length) el.createDiv({ cls: "gc-embed-foot", text: notes.join(" ") });
		} catch (e) {
			if (token !== this.token) return;
			this.data = null;
			say(`GridCraft couldn't show ${this.file.name}: ${errorText(e)}`, true);
		}
	}

	private copyMenu(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		const data = this.data;
		if (!data) return;
		const copy = async (text: string, what: string) => {
			try {
				await navigator.clipboard.writeText(text);
				new Notice(`Copied the table as ${what}.`);
			} catch (err) {
				new Notice(`Couldn't copy: ${errorText(err)}`);
			}
		};
		new Menu()
			.addItem((i) =>
				i
					.setTitle("Copy as Markdown table")
					.setIcon("table")
					.onClick(() => void copy(toMarkdown(data), "Markdown")),
			)
			.addItem((i) =>
				i
					.setTitle("Copy as tab-separated text")
					.setIcon("clipboard-copy")
					.onClick(() => void copy(toTsv(data), "tab-separated text")),
			)
			.showAtMouseEvent(e);
	}
}

/**
 * The `gridcraft` code block:
 *
 *     ```gridcraft
 *     file: Budget.xlsx          (or [[Budget.xlsx#Sheet1!A1:D20]])
 *     sheet: Sheet1              (optional)
 *     range: A1:D20              (optional)
 *     headers: true              (optional: column letters and row numbers)
 *     ```
 */
export function parseCodeBlock(source: string): { path: string; target: SheetTarget } {
	let path = "";
	const target: SheetTarget = {};
	for (const raw of source.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#") || line.startsWith("//")) continue;
		const m = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(line);
		if (!m) {
			// A bare link or path on its own line.
			if (!path) path = line;
			continue;
		}
		const key = m[1].toLowerCase();
		const value = m[2].trim();
		if (key === "file" || key === "path") path = value;
		else if (key === "sheet") target.sheet = value.replace(/^["'](.*)["']$/, "$1");
		else if (key === "range") target.range = value;
		else if (key === "headers") target.headers = /^(true|yes|on|1)$/i.test(value);
	}
	// [[Budget.xlsx#Sheet1!A1:D20]] or [[Budget.xlsx|alias]]
	path = path.replace(/^!?\[\[(.*)\]\]$/, "$1").split("|")[0].trim();
	const hash = path.indexOf("#");
	if (hash >= 0) {
		const fromLink = parseSubpath(path.slice(hash + 1));
		path = path.slice(0, hash);
		target.sheet ??= fromLink.sheet;
		target.range ??= fromLink.range;
	}
	return { path, target };
}

function statusText(s: EngineStatus): string {
	return s === "downloading" ? "Downloading the GridCraft engine (about 2.8 MB, one time only)…" : "Starting GridCraft…";
}
