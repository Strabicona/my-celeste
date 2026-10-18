// Moves the game files between the browser's storage and the site's cloud
// storage as one archive (Content folder + the clean Celeste.exe + the
// already-patched CustomCeleste.dll), cut into 1.4 MB pieces. Because the
// patched file travels with it, a fresh browser only downloads and unpacks;
// it never has to re-patch the game.
import { createTar, extractTar, rootFolder } from "./fs";
import {
	commitGame,
	GameInfo,
	getPiece,
	PIECE,
	putPiece,
	startGameUpload,
} from "./cloud";

const GAME_ITEMS = ["Content", "Celeste.exe", "CustomCeleste.dll"];
const VERSION_FILE = ".GameVersion";

// Which online game copy this browser's files came from, so a fixed or
// replaced copy is downloaded again instead of reusing old local files.
export async function localGameVersion(): Promise<string | null> {
	try {
		const f = await rootFolder.getFileHandle(VERSION_FILE, { create: false });
		return (await (await f.getFile()).text()).trim() || null;
	} catch {
		return null;
	}
}

async function setLocalGameVersion(version: string) {
	const f = await rootFolder.getFileHandle(VERSION_FILE, { create: true });
	const w = await f.createWritable();
	await w.write(version);
	await w.close();
}

export async function removeLocalGame() {
	for (const name of [...GAME_ITEMS, ".ContentExists", VERSION_FILE]) {
		try {
			await rootFolder.removeEntry(name, { recursive: true });
		} catch {}
	}
}
const PARALLEL = 4;

async function folderSize(dir: FileSystemDirectoryHandle): Promise<number> {
	let total = 0;
	for await (const [, entry] of dir) {
		if (entry.kind === "file") {
			total += (await (entry as FileSystemFileHandle).getFile()).size;
		} else {
			total += await folderSize(entry as FileSystemDirectoryHandle);
		}
	}
	return total;
}

export async function localGameSize(): Promise<number> {
	let total = 0;
	for (const name of GAME_ITEMS) {
		try {
			total += await folderSize(
				await rootFolder.getDirectoryHandle(name, { create: false })
			);
			continue;
		} catch {}
		try {
			total += (
				await (await rootFolder.getFileHandle(name, { create: false })).getFile()
			).size;
		} catch {}
	}
	return total;
}

export async function uploadGame(onProgress: (fraction: number) => void) {
	const total = Math.max(1, await localGameSize());
	const version = "v" + Date.now().toString(36);
	await startGameUpload();

	const reader = (createTar(rootFolder, undefined, GAME_ITEMS) as ReadableStream<Uint8Array>).getReader();
	let buffer = new Uint8Array(PIECE);
	let filled = 0;
	let index = 0;
	let sent = 0;
	const inflight = new Set<Promise<void>>();

	const send = async (data: Uint8Array, i: number) => {
		const p = putPiece(version, i, data).then(() => {
			sent += data.length;
			onProgress(Math.min(1, sent / total));
		});
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
			if (filled === PIECE) {
				await send(buffer, index++);
				buffer = new Uint8Array(PIECE);
				filled = 0;
			}
		}
	}
	if (filled > 0) await send(buffer.slice(0, filled), index++);
	await Promise.all(inflight);

	await commitGame({ version, pieces: index, size: total });
	await setLocalGameVersion(version);
}

export async function downloadGame(info: GameInfo, onProgress: (fraction: number) => void) {
	let next = 0;
	let got = 0;
	// fetch a few pieces ahead, hand them to the unpacker strictly in order
	const pending = new Map<number, Promise<Uint8Array>>();
	const fetchAhead = () => {
		while (pending.size < PARALLEL + 2 && next < info.pieces) {
			pending.set(next, getPiece(info.version, next));
			next++;
		}
	};
	let current = 0;
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (current >= info.pieces) {
				controller.close();
				return;
			}
			fetchAhead();
			const data = await pending.get(current)!;
			pending.delete(current);
			current++;
			got += data.length;
			onProgress(Math.min(1, got / Math.max(1, info.size)));
			controller.enqueue(data);
		},
	});
	await extractTar(stream, rootFolder);
	await rootFolder.getFileHandle(".ContentExists", { create: true });
	await setLocalGameVersion(info.version);
}
