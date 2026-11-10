// Extra bundles that sit next to the game in the cloud, each unpacked into the
// browser's storage on top of the game files:
//   everest     Everest, already patched into the game (CustomCeleste.dll +
//               Celeste/Everest). Made once in a browser, then reused everywhere.
//   everestzip  the Everest download, put online by the GitHub upload job, so
//               the one-time patch never needs a proxy.
//   mods-sj     Celeste/Mods for the Strawberry Jam link (+ skin)
//   mods-ds     Celeste/Mods for the D-Sides link (+ skin)
// Each browser remembers which copy of a bundle it unpacked, so a bundle is only
// downloaded when it is missing or has changed online.
import { createTar, extractTar, rootFolder } from "./fs";
import {
	commitPack,
	getPackPiece,
	PackInfo,
	packInfo,
	PIECE,
	putPackPiece,
	startPackUpload,
} from "./cloud";
import { readFileRetry } from "./readretry";

const PARALLEL = 4;

export function packKey(info: { version: string; pieces: number }) {
	return `${info.version}+${info.pieces}`;
}

const marker = (slot: string) => `.Pack-${slot}`;

export async function localPack(slot: string): Promise<string | null> {
	try {
		const f = await rootFolder.getFileHandle(marker(slot), { create: false });
		const { bytes } = await readFileRetry(f);
		return new TextDecoder().decode(bytes).trim() || null;
	} catch {
		return null;
	}
}

export async function setLocalPack(slot: string, value: string | null) {
	if (value === null) {
		try {
			await rootFolder.removeEntry(marker(slot));
		} catch {}
		return;
	}
	const f = await rootFolder.getFileHandle(marker(slot), { create: true });
	const w = await f.createWritable();
	await w.write(value);
	await w.close();
}

async function celesteFolder() {
	return rootFolder.getDirectoryHandle("Celeste", { create: true });
}

// removes the unpacked Everest (the game's own CustomCeleste.dll is replaced by
// the game download anyway)
export async function removeLocalEverest() {
	try {
		await (await celesteFolder()).removeEntry("Everest", { recursive: true });
	} catch {}
	try {
		await rootFolder.removeEntry("everest.zip");
	} catch {}
	await setLocalPack("everest", null);
}

// empties Celeste/Mods (mods, Everest's cache of them, its mod list)
export async function removeLocalMods() {
	try {
		await (await celesteFolder()).removeEntry("Mods", { recursive: true });
	} catch {}
	await setLocalPack("mods", null);
}

export async function downloadPack(
	name: string,
	info: PackInfo,
	onProgress: (fraction: number) => void,
	// only the first `limit` bytes (the no-sound links stop before the music)
	limit?: number
) {
	const total = limit && limit < info.size ? limit : info.size;
	const pieces = Math.min(info.pieces, Math.ceil(total / PIECE));
	let next = 0;
	let got = 0;
	const pending = new Map<number, Promise<Uint8Array>>();
	const fetchAhead = () => {
		while (pending.size < PARALLEL + 2 && next < pieces) {
			pending.set(next, getPackPiece(name, info.version, next));
			next++;
		}
	};
	let current = 0;
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (current >= pieces) {
				// cut short: add the end-of-archive mark so the unpacker stops cleanly
				if (total < info.size) controller.enqueue(new Uint8Array(1024));
				controller.close();
				return;
			}
			fetchAhead();
			let data = await pending.get(current)!;
			pending.delete(current);
			current++;
			if (got + data.length > total) data = data.slice(0, total - got);
			got += data.length;
			onProgress(Math.min(1, got / Math.max(1, total)));
			controller.enqueue(data);
		},
	});
	await extractTar(stream, rootFolder);
}

export async function uploadPack(
	name: string,
	keep: (path: string) => boolean,
	extra: Record<string, unknown>,
	onProgress: (fraction: number) => void
): Promise<PackInfo> {
	const version = "v" + Date.now().toString(36);
	await startPackUpload(name);
	const reader = (
		createTar(rootFolder, undefined, undefined, keep) as ReadableStream<Uint8Array>
	).getReader();
	let buffer = new Uint8Array(PIECE);
	let filled = 0;
	let index = 0;
	let size = 0;
	const inflight = new Set<Promise<void>>();
	const send = async (data: Uint8Array, i: number) => {
		const p = putPackPiece(name, version, i, data);
		inflight.add(p);
		p.finally(() => inflight.delete(p)).catch(() => {});
		if (inflight.size >= PARALLEL) await Promise.race(inflight);
	};
	for (;;) {
		const { value, done } = await reader.read();
		if (done || !value) break;
		let offset = 0;
		while (offset < value.length) {
			const n = Math.min(PIECE - filled, value.length - offset);
			buffer.set(value.subarray(offset, offset + n), filled);
			filled += n;
			offset += n;
			size += n;
			if (filled === PIECE) {
				await send(buffer, index++);
				buffer = new Uint8Array(PIECE);
				filled = 0;
				onProgress(Math.min(0.99, index / (index + 4)));
			}
		}
	}
	if (filled > 0) await send(buffer.slice(0, filled), index++);
	await Promise.all(inflight);
	const info = { version, pieces: index, size, ...extra };
	await commitPack(name, info);
	onProgress(1);
	return { ...info, uploaded: Date.now() };
}

// what goes into the Everest pack: the patched game file and Celeste/Everest
export const keepEverest = (p: string) =>
	p === "CustomCeleste.dll" ||
	p === "Celeste" ||
	p === "Celeste/Everest" ||
	p.startsWith("Celeste/Everest/");

export { packInfo };
