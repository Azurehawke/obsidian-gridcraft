// Loads GridCraft's engine (WebAssembly) once per session.
//
// A release build knows the SHA-256 of the exact engine it was built with. The engine lives in
// the plugin folder as engine-<version>.wasm; when it's missing (first use, or after an update)
// it is downloaded from this plugin's GitHub release of the same version, unpacked, checked
// against that fingerprint, and saved. Syncthing (or any vault sync) then carries the file to
// other devices, which find it already in place.
//
// A development build (`npm run dev`) has no fingerprint and loads engine.wasm from the plugin
// folder without checks.

import { normalizePath, requestUrl, type DataAdapter, type Plugin } from "obsidian";
import initEngine, { Book } from "../engine/pkg/gridcraft_obsidian_engine.js";

declare const ENGINE_SHA256: string;
declare const ENGINE_REPO: string;

export type BookClass = typeof Book;
export type { Book };

const ASSET = "gridcraft-engine.wasm.gz";

/** Progress the views show while the engine loads. */
export type EngineStatus = "checking" | "downloading" | "starting";

export class EngineLoader {
	private loading: Promise<BookClass> | null = null;
	private listeners = new Set<(s: EngineStatus) => void>();

	constructor(private plugin: Plugin) {}

	/** The engine, loading (and downloading) it on first call. A failed load is retried on the next call. */
	get(onStatus?: (s: EngineStatus) => void): Promise<BookClass> {
		if (onStatus) this.listeners.add(onStatus);
		if (!this.loading) {
			this.loading = this.load().catch((e) => {
				this.loading = null;
				throw e;
			});
		}
		const done = () => {
			if (onStatus) this.listeners.delete(onStatus);
		};
		this.loading.then(done, done);
		return this.loading;
	}

	private status(s: EngineStatus) {
		for (const l of this.listeners) l(s);
	}

	private async load(): Promise<BookClass> {
		const adapter = this.plugin.app.vault.adapter;
		const dir = this.plugin.manifest.dir ?? normalizePath(`${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`);
		const version = this.plugin.manifest.version;
		let bytes: ArrayBuffer;

		if (!ENGINE_SHA256) {
			const dev = normalizePath(`${dir}/engine.wasm`);
			if (!(await adapter.exists(dev))) {
				throw new Error(`Development build: copy engine/pkg/gridcraft_obsidian_engine_bg.wasm to ${dev}.`);
			}
			bytes = await adapter.readBinary(dev);
		} else {
			this.status("checking");
			const file = normalizePath(`${dir}/engine-${version}.wasm`);
			let cached: ArrayBuffer | null = null;
			if (await adapter.exists(file)) {
				const b = await adapter.readBinary(file);
				// A partial or wrong file (an interrupted sync, say) is fetched again.
				if ((await sha256(b)) === ENGINE_SHA256) cached = b;
			}
			if (cached) {
				bytes = cached;
			} else {
				this.status("downloading");
				bytes = await download(version);
				await adapter.writeBinary(file, bytes);
				await removeOldEngines(adapter, dir, file);
			}
		}

		this.status("starting");
		await initEngine({ module_or_path: bytes });
		return Book;
	}
}

async function download(version: string): Promise<ArrayBuffer> {
	const url = `https://github.com/${ENGINE_REPO}/releases/download/${version}/${ASSET}`;
	let res;
	try {
		res = await requestUrl({ url, method: "GET", throw: false });
	} catch (e) {
		throw new Error(`Couldn't download the GridCraft engine. Check your connection and try again. (${errorText(e)})`);
	}
	if (res.status !== 200) {
		throw new Error(`Couldn't download the GridCraft engine (HTTP ${res.status} from ${url}).`);
	}
	const raw = await gunzip(res.arrayBuffer);
	if ((await sha256(raw)) !== ENGINE_SHA256) {
		throw new Error("The downloaded GridCraft engine didn't match this plugin version, so it wasn't used. Try again, or reinstall the plugin.");
	}
	return raw;
}

async function gunzip(data: ArrayBuffer): Promise<ArrayBuffer> {
	if (typeof DecompressionStream === "undefined") {
		throw new Error("This device can't unpack the GridCraft engine (no DecompressionStream).");
	}
	const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"));
	return await new Response(stream).arrayBuffer();
}

async function sha256(data: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Deletes engines left by earlier versions (and sync-conflict copies). */
async function removeOldEngines(adapter: DataAdapter, dir: string, keep: string) {
	try {
		const list = await adapter.list(dir);
		for (const f of list.files) {
			const name = f.split("/").pop() ?? "";
			if (f !== keep && /^engine-.*\.wasm$/.test(name)) await adapter.remove(f);
		}
	} catch {
		// Leftovers only cost disk space; never fail a load over them.
	}
}

export function errorText(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}
