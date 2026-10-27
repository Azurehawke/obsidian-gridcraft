import { debounce, Notice, Plugin, TFile, type Component } from "obsidian";
import { parseCodeBlock, parseSubpath, SheetBlock } from "./embed";
import { EngineLoader } from "./engine";
import { EXTENSIONS, SheetView, VIEW_TYPE } from "./view";

/**
 * Obsidian's embed registry (`![[file.ext]]`). Not part of the public API, so everything that
 * touches it is guarded: if a future Obsidian changes it, embeds fall back to a plain link and
 * the `gridcraft` code block still works.
 */
interface EmbedRegistry {
	registerExtension(ext: string, creator: (ctx: { containerEl: HTMLElement }, file: TFile, subpath?: string) => Component): void;
	unregisterExtension(ext: string): void;
}

export default class GridCraftPlugin extends Plugin {
	engine!: EngineLoader;
	/** Sheet tables currently shown in notes, refreshed when their file changes. */
	readonly blocks = new Set<SheetBlock>();

	override async onload() {
		this.engine = new EngineLoader(this);
		this.registerView(VIEW_TYPE, (leaf) => new SheetView(leaf, this));

		// One at a time, so a clash with another plugin over one extension leaves the others working.
		const taken: string[] = [];
		for (const ext of EXTENSIONS) {
			try {
				this.registerExtensions([ext], VIEW_TYPE);
			} catch {
				taken.push(`.${ext}`);
			}
		}
		if (taken.length > 0) {
			new Notice(`GridCraft Viewer: another plugin already opens ${taken.join(" and ")} files. Disable it to open them with GridCraft.`, 10000);
		}

		this.registerEmbeds();

		this.registerMarkdownCodeBlockProcessor("gridcraft", (source, el, ctx) => {
			const { path, target } = parseCodeBlock(source);
			if (!path) {
				el.createDiv({ cls: "gc-embed-msg gc-error", text: "gridcraft block: add a line such as  file: Budget.xlsx" });
				return;
			}
			const file = this.app.metadataCache.getFirstLinkpathDest(path, ctx.sourcePath);
			if (!(file instanceof TFile)) {
				el.createDiv({ cls: "gc-embed-msg gc-error", text: `gridcraft block: can't find ${path} in the vault.` });
				return;
			}
			const holder = el.createDiv();
			ctx.addChild(new SheetBlock(this, holder, file, target));
		});

		// A workbook changed by GridCraft (or arriving through sync) refreshes its tabs and tables.
		const reloads = new Map<string, () => void>();
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (!(file instanceof TFile) || !EXTENSIONS.includes(file.extension.toLowerCase())) return;
				let run = reloads.get(file.path);
				if (!run) {
					run = debounce(() => this.refresh(file.path), 700, true);
					reloads.set(file.path, run);
				}
				run();
			}),
		);
	}

	private registerEmbeds() {
		const registry = (this.app as unknown as { embedRegistry?: EmbedRegistry }).embedRegistry;
		if (!registry || typeof registry.registerExtension !== "function") return;
		for (const ext of EXTENSIONS) {
			try {
				registry.registerExtension(ext, (ctx, file, subpath) => new SheetBlock(this, ctx.containerEl, file, parseSubpath(subpath)));
			} catch {
				// Another plugin shows these embeds; leave it alone.
				continue;
			}
			this.register(() => {
				try {
					registry.unregisterExtension(ext);
				} catch {
					// Already gone.
				}
			});
		}
	}

	private refresh(path: string) {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof SheetView && view.file?.path === path) void view.reload();
		}
		for (const block of this.blocks) {
			if (block.file.path === path) void block.render();
		}
	}
}
