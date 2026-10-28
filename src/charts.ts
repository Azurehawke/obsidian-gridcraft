// Charts over the grid (and in notes). The engine draws each chart as SVG; this places them at
// their sheet position and, in the tab, lets you select, move and resize them.

export interface ChartInfo {
	id: number;
	index: number;
	name: string;
	kind: string;
	title: string | null;
	legend: string;
	dataLabels: boolean;
	gridlines: boolean;
	/** Sheet pixels from the top-left of A1. */
	left: number;
	top: number;
	width: number;
	height: number;
	svg: string | null;
}

/** The engine's SVG as a live element (parsed, never injected as HTML). */
export function svgElement(doc: Document, svg: string): SVGSVGElement | null {
	const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
	const root = parsed.documentElement;
	if (!root || root.nodeName.toLowerCase() !== "svg" || parsed.getElementsByTagName("parsererror").length > 0) return null;
	return doc.importNode(root, true) as unknown as SVGSVGElement;
}

export interface ChartLayerOptions {
	/** Select, move, resize (the tab). Notes only show charts. */
	interactive: boolean;
	/** A chart was moved or resized: new top-left in sheet pixels and size. */
	onPlace?: (id: number, left: number, top: number, width: number, height: number) => void;
	/** The selected chart changed (null: none). */
	onSelect?: (chart: ChartInfo | null) => void;
	/** Fills the small toolbar shown above a selected chart. */
	toolbar?: (bar: HTMLElement, chart: ChartInfo) => void;
}

/** Charts drawn over a grid whose cell A1 starts at `origin` within `parent`. */
export class ChartLayer {
	readonly el: HTMLElement;
	private boxes = new Map<number, HTMLElement>();
	private charts = new Map<number, ChartInfo>();
	private selectedId: number | null = null;
	private bar: HTMLElement | null = null;

	constructor(parent: HTMLElement, origin: { left: number; top: number }, charts: ChartInfo[], private opts: ChartLayerOptions) {
		this.el = parent.createDiv({ cls: "gc-charts" });
		this.el.style.left = `${origin.left}px`;
		this.el.style.top = `${origin.top}px`;
		const doc = parent.ownerDocument;
		for (const c of charts) {
			this.charts.set(c.id, c);
			const box = this.el.createDiv({ cls: "gc-chart", attr: { "aria-label": c.title ? `${c.name}: ${c.title}` : c.name } });
			box.dataset.id = String(c.id);
			place(box, c.left, c.top, c.width, c.height);
			const svg = c.svg ? svgElement(doc, c.svg) : null;
			if (svg) box.appendChild(svg);
			else box.createDiv({ cls: "gc-chart-empty", text: c.name });
			this.boxes.set(c.id, box);
			if (opts.interactive) this.makeInteractive(box, c);
		}
	}

	get selected(): ChartInfo | null {
		return this.selectedId === null ? null : (this.charts.get(this.selectedId) ?? null);
	}

	/** Selects chart `id` (null clears), showing its outline, resize handle and toolbar. */
	select(id: number | null) {
		if (id !== null && !this.charts.has(id)) id = null;
		if (id === this.selectedId) return;
		if (this.selectedId !== null) this.boxes.get(this.selectedId)?.removeClass("is-selected");
		this.bar?.remove();
		this.bar = null;
		this.selectedId = id;
		const info = this.selected;
		if (id !== null && info) {
			const box = this.boxes.get(id);
			box?.addClass("is-selected");
			if (box && this.opts.toolbar) {
				this.bar = this.el.createDiv({ cls: "gc-chart-bar" });
				this.positionBar(box);
				this.opts.toolbar(this.bar, info);
			}
		}
		this.opts.onSelect?.(info);
	}

	private positionBar(box: HTMLElement) {
		if (!this.bar) return;
		const top = parseFloat(box.style.top) || 0;
		this.bar.style.left = box.style.left;
		this.bar.style.top = `${Math.max(0, top - 34)}px`;
	}

	private makeInteractive(box: HTMLElement, c: ChartInfo) {
		const handle = box.createDiv({ cls: "gc-chart-handle", attr: { "aria-label": "Drag to resize" } });
		const drag = (e: PointerEvent, resize: boolean) => {
			if (e.button !== 0) return;
			e.preventDefault();
			e.stopPropagation();
			this.select(c.id);
			const target = e.currentTarget as HTMLElement;
			target.setPointerCapture(e.pointerId);
			const x0 = e.clientX;
			const y0 = e.clientY;
			const start = { left: parseFloat(box.style.left), top: parseFloat(box.style.top), width: parseFloat(box.style.width), height: parseFloat(box.style.height) };
			let now = { ...start };
			const move = (ev: PointerEvent) => {
				const dx = ev.clientX - x0;
				const dy = ev.clientY - y0;
				now = resize
					? { ...start, width: Math.max(60, start.width + dx), height: Math.max(40, start.height + dy) }
					: { ...start, left: Math.max(0, start.left + dx), top: Math.max(0, start.top + dy) };
				place(box, now.left, now.top, now.width, now.height);
				this.positionBar(box);
				// Keep the drawing crisp while resizing: it's redrawn at the new size on release.
				const svg = box.querySelector("svg");
				if (svg && resize) {
					svg.setAttribute("width", String(now.width));
					svg.setAttribute("height", String(now.height));
					svg.setAttribute("preserveAspectRatio", "none");
				}
			};
			const up = () => {
				target.removeEventListener("pointermove", move);
				target.removeEventListener("pointerup", up);
				target.removeEventListener("pointercancel", up);
				const moved = Math.abs(now.left - start.left) + Math.abs(now.top - start.top) + Math.abs(now.width - start.width) + Math.abs(now.height - start.height);
				if (moved >= 2) this.opts.onPlace?.(c.id, now.left, now.top, now.width, now.height);
			};
			target.addEventListener("pointermove", move);
			target.addEventListener("pointerup", up);
			target.addEventListener("pointercancel", up);
		};
		box.addEventListener("pointerdown", (e) => {
			if (e.target === handle) return;
			drag(e, false);
		});
		handle.addEventListener("pointerdown", (e) => drag(e, true));
		// Clicks on a chart never reach the cells underneath.
		box.addEventListener("mousedown", (e) => e.stopPropagation());
		box.addEventListener("dblclick", (e) => e.stopPropagation());
	}
}

function place(el: HTMLElement, left: number, top: number, width: number, height: number) {
	el.style.left = `${Math.round(left)}px`;
	el.style.top = `${Math.round(top)}px`;
	el.style.width = `${Math.round(width)}px`;
	el.style.height = `${Math.round(height)}px`;
}

/** Chart types offered when inserting or changing a chart: [label, engine type, subtype]. */
export const CHART_TYPES: [string, string, string | undefined][] = [
	["Clustered column", "column", undefined],
	["Stacked column", "column", "stacked"],
	["100% stacked column", "column", "stacked100"],
	["Clustered bar", "bar", undefined],
	["Stacked bar", "bar", "stacked"],
	["Line", "line", undefined],
	["Line with markers", "line", "markers"],
	["Pie", "pie", undefined],
	["Doughnut", "doughnut", undefined],
	["Area", "area", undefined],
	["Stacked area", "area", "stacked"],
	["Scatter", "scatter", undefined],
	["Radar", "radar", undefined],
	["Waterfall", "waterfall", undefined],
	["Funnel", "funnel", undefined],
];

/** "Chart 2" (1-based, as the engine names them) to an index, or -1. */
export function chartIndex(name: string | undefined): number {
	const m = /^\s*chart\s*(\d+)\s*$/i.exec(name ?? "");
	return m ? Number(m[1]) - 1 : -1;
}
