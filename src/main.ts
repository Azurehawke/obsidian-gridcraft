import { debounce, Notice, Plugin, TFile } from "obsidian";
import { EngineLoader } from "./engine";
import { EXTENSIONS, SheetView, VIEW_TYPE } from "./view";

export default class GridCraftPlugin extends Plugin {
	engine!: EngineLoader;

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

		// A workbook changed by GridCraft (or arriving through sync) refreshes its open tabs.
		const reloads = new Map<string, () => void>();
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (!(file instanceof TFile) || !EXTENSIONS.includes(file.extension.toLowerCase())) return;
				let run = reloads.get(file.path);
				if (!run) {
					run = debounce(() => this.reloadViews(file.path), 700, true);
					reloads.set(file.path, run);
				}
				run();
			}),
		);
	}

	private reloadViews(path: string) {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof SheetView && view.file?.path === path) void view.reload();
		}
	}
}
