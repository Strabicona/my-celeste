// Keeps the game's save folder (Celeste/Saves in browser storage) in step with
// the site's cloud storage.
//
// - Before the game starts, pullSaves() brings the cloud saves into the browser.
//   If a save in the browser is newer than the cloud copy, the browser copy wins
//   and is sent up instead.
// - While the page is open, every changed save is sent up a few seconds after
//   the game finishes writing it. The server keeps the previous version as a
//   backup, and only the newest 3 backups per save file.
import { rootFolder } from "./fs";
import { cloudState, getSave, listSaves, LockedError, putSave } from "./cloud";

const SAVES_PATH = ["Celeste", "Saves"];
const POLL_MS = 2000;

// Vanilla save files only: numbered slots, settings, and the debug slot.
// Everest mod files (0-modsave…, modsettings-…) are never synced.
export function isSyncedSave(name: string) {
	return /^(\d+|settings|debug)\.celeste$/.test(name);
}

async function savesDir(): Promise<FileSystemDirectoryHandle> {
	let dir = rootFolder;
	for (const part of SAVES_PATH) {
		dir = await dir.getDirectoryHandle(part, { create: true });
	}
	return dir;
}

type Seen = { size: number; lastModified: number };
// what the browser file looked like when it last matched the cloud
const synced = new Map<string, Seen>();
// last observation, used to wait until the game has finished writing
const lastSeen = new Map<string, Seen>();

async function readLocal(): Promise<Map<string, File>> {
	const out = new Map<string, File>();
	const dir = await savesDir();
	for await (const [name, handle] of dir) {
		if (handle.kind !== "file" || !isSyncedSave(name)) continue;
		try {
			out.set(name, await (handle as FileSystemFileHandle).getFile());
		} catch {
			// the game may be writing it right now; next poll will catch it
		}
	}
	return out;
}

function same(a: Seen | undefined, b: Seen) {
	return !!a && a.size === b.size && a.lastModified === b.lastModified;
}

function equalBytes(a: Uint8Array, b: Uint8Array) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

export async function hasCloudSaves(): Promise<boolean> {
	return (await listSaves()).some((x) => isSyncedSave(x.name));
}

export async function pullSaves(): Promise<void> {
	const remote = (await listSaves()).filter((x) => isSyncedSave(x.name));
	const local = await readLocal();
	const dir = await savesDir();

	for (const r of remote) {
		const l = local.get(r.name);
		if (l && l.lastModified > r.modified) {
			const [lb, rb] = await Promise.all([
				l.arrayBuffer().then((x) => new Uint8Array(x)),
				getSave(r.name),
			]);
			if (!equalBytes(lb, rb)) {
				console.log(`[saves] keeping newer browser copy of ${r.name}`);
				continue; // left unsynced on purpose: the sync loop uploads it
			}
			synced.set(r.name, { size: l.size, lastModified: l.lastModified });
			continue;
		}
		const data = await getSave(r.name);
		const handle = await dir.getFileHandle(r.name, { create: true });
		const w = await handle.createWritable();
		await w.write(data);
		await w.close();
		const written = await handle.getFile();
		synced.set(r.name, { size: written.size, lastModified: written.lastModified });
		console.log(`[saves] loaded ${r.name} from the cloud`);
	}
	cloudState.lastSaved = "loaded";
}

let running = false;

async function syncOnce(urgent = false, keepalive = false) {
	if (running) return;
	running = true;
	try {
		const local = await readLocal();
		const pending: [string, File][] = [];
		for (const [name, file] of local) {
			const now = { size: file.size, lastModified: file.lastModified };
			if (same(synced.get(name), now)) continue;
			// wait for two identical looks in a row, so a half-written file
			// is never uploaded (skipped when the page is closing)
			if (!urgent && !same(lastSeen.get(name), now)) {
				lastSeen.set(name, now);
				continue;
			}
			pending.push([name, file]);
		}
		cloudState.waiting = pending.length;
		if (pending.length === 0) return;

		cloudState.syncing = true;
		for (const [name, file] of pending) {
			await putSave(name, new Uint8Array(await file.arrayBuffer()), keepalive);
			synced.set(name, { size: file.size, lastModified: file.lastModified });
			console.log(`[saves] sent ${name} to the cloud`);
		}
		cloudState.waiting = 0;
		cloudState.lastSaved = new Date().toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
		});
		cloudState.error = "";
	} catch (e) {
		console.error("[saves] sync failed:", e);
		cloudState.error =
			e instanceof LockedError ? "Password needed again, reload the page" : String(e);
	} finally {
		cloudState.syncing = false;
		running = false;
	}
}

let started = false;
export function startSaveSync() {
	if (started) return;
	started = true;
	setInterval(() => syncOnce(false), POLL_MS);
	// last-chance send when the tab is hidden or closed
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") syncOnce(true, true);
	});
	window.addEventListener("pagehide", () => syncOnce(true, true));
}

export async function syncNow() {
	await syncOnce(true);
}

// Copies vanilla saves out of a picked PC Celeste folder (first-time setup).
export async function copySavesFromFolder(gameFolder: FileSystemDirectoryHandle) {
	let src: FileSystemDirectoryHandle;
	try {
		src = await gameFolder.getDirectoryHandle("Saves", { create: false });
	} catch {
		return 0;
	}
	const dst = await savesDir();
	let n = 0;
	for await (const [name, handle] of src) {
		if (handle.kind !== "file" || !isSyncedSave(name)) continue;
		const data = await (handle as FileSystemFileHandle).getFile();
		const out = await dst.getFileHandle(name, { create: true });
		const w = await out.createWritable();
		await w.write(await data.arrayBuffer());
		await w.close();
		n++;
	}
	return n;
}

async function writeSave(name: string, data: ArrayBuffer) {
	const dst = await savesDir();
	const out = await dst.getFileHandle(name, { create: true });
	const w = await out.createWritable();
	await w.write(data);
	await w.close();
}

// Same as copySavesFromFolder, for a folder that was dragged onto the page.
export async function copySavesFromDroppedFolder(gameFolder: FileSystemDirectoryEntry) {
	const read = (dir: FileSystemDirectoryEntry) =>
		new Promise<FileSystemEntry[]>((res, rej) => dir.createReader().readEntries(res, rej));
	const saves = (await read(gameFolder)).find((e) => e.isDirectory && e.name === "Saves") as
		| FileSystemDirectoryEntry
		| undefined;
	if (!saves) return 0;
	let n = 0;
	for (const entry of await read(saves)) {
		if (!entry.isFile || !isSyncedSave(entry.name)) continue;
		const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
		await writeSave(entry.name, await file.arrayBuffer());
		n++;
	}
	return n;
}

// "Import save from this PC": pick save files (0.celeste, settings.celeste...)
// and put them in place; the sync then sends them online.
export async function importSaveFiles(files: File[]): Promise<string[]> {
	const done: string[] = [];
	for (const f of files) {
		if (!isSyncedSave(f.name)) continue;
		await writeSave(f.name, await f.arrayBuffer());
		done.push(f.name);
	}
	if (done.length) await syncNow();
	return done;
}
