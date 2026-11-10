// Keeps the game's save folder (Celeste/Saves in browser storage) in step with
// the site's cloud storage.
//
// - Before the game starts, pullSaves() brings the cloud saves into the browser.
//   If a save in the browser is newer than the cloud copy, the browser copy wins
//   and is sent up instead.
// - While the page is open, every changed save is sent up a few seconds after
//   the game finishes writing it. The server keeps the previous version as a
//   backup, and only the newest 3 backups per save file.
import { readAllEntries, rootFolder } from "./fs";
import { cloudState, CloudSave, getSave, listSaves, LockedError, putSave } from "./cloud";
import { profile, PROFILES } from "./profile";
import { readFileRetry } from "./readretry";

const SAVES_PATH = ["Celeste", "Saves"];
// every 5 s (was 2 s): Strawberry Jam writes ~80 save files, and each look
// reads all of them (9 Nov 2026, choppiness after a while)
const POLL_MS = 5000;

// Every save file the game writes: numbered slots, settings, debug, and
// Everest's mod files (0-modsave-…, modsettings-…), which hold mod progress.
export function isSyncedSave(name: string) {
	return /^[A-Za-z0-9 _.'+\-]{1,100}\.celeste$/.test(name);
}

// Each link keeps its own saves online, behind its own name prefix
// ("sj~0.celeste"). The old saves without a prefix stay untouched online and
// only seed a link the first time it is used.
const PREFIX = profile?.savePrefix ?? "";
const VANILLA = /^(\d+|settings|debug)\.celeste$/;
const PROFILE_MARKER = ".SaveProfile";

type Remote = { name: string; cloud: string; modified: number };

function ownRemote(list: CloudSave[], prefix = PREFIX): Remote[] {
	return list
		.filter((x) => (prefix ? x.name.startsWith(prefix) : !x.name.includes("~")))
		.map((x) => ({ name: x.name.slice(prefix.length), cloud: x.name, modified: x.modified }))
		.filter((x) => isSyncedSave(x.name));
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

type Local = {
	handle: FileSystemFileHandle;
	size: number;
	lastModified: number;
};

async function readLocal(): Promise<Map<string, Local>> {
	const out = new Map<string, Local>();
	const dir = await savesDir();
	for await (const [name, handle] of dir) {
		if (handle.kind !== "file" || !isSyncedSave(name)) continue;
		try {
			const f = await (handle as FileSystemFileHandle).getFile();
			out.set(name, {
				handle: handle as FileSystemFileHandle,
				size: f.size,
				lastModified: f.lastModified,
			});
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
	return ownRemote(await listSaves()).length > 0;
}

async function readMarker(): Promise<string | null> {
	try {
		const f = await rootFolder.getFileHandle(PROFILE_MARKER, { create: false });
		return new TextDecoder().decode((await readFileRetry(f)).bytes).trim() || null;
	} catch {
		return null;
	}
}

async function writeMarker(value: string) {
	const f = await rootFolder.getFileHandle(PROFILE_MARKER, { create: true });
	const w = await f.createWritable();
	await w.write(value);
	await w.close();
}

// The browser's save folder belongs to the link last played here. Before a
// different link uses it, anything newer than that link's online copy is sent
// up, then the folder is emptied.
async function switchSaveFolder(all: CloudSave[]) {
	// the marker holds the save prefix ("p:sj~"); older markers hold a link id
	const mine = "p:" + PREFIX;
	const raw = (await readMarker()) ?? "base"; // older browsers: unprefixed saves
	const owner = raw.startsWith("p:")
		? raw
		: raw === "base"
			? "p:"
			: "p:" + (Object.values(PROFILES).find((p) => p.id === raw)?.savePrefix ?? "?");
	if (owner === mine) return;
	const ownerPrefix = owner === "p:?" ? null : owner.slice(2);
	const local = await readLocal();
	if (ownerPrefix !== null) {
		const remote = new Map(ownRemote(all, ownerPrefix).map((r) => [r.name, r]));
		for (const [name, l] of local) {
			const r = remote.get(name);
			if (r && r.modified >= l.lastModified) continue;
			const snap = await readFileRetry(l.handle);
			if (r && equalBytes(snap.bytes, await getSave(r.cloud))) continue;
			await putSave(ownerPrefix + name, snap.bytes);
			console.log(`[saves] sent ${name} back to the ${owner} saves before switching`);
		}
	}
	const dir = await savesDir();
	for (const name of local.keys()) {
		try {
			await dir.removeEntry(name);
		} catch {}
	}
	synced.clear();
	lastSeen.clear();
	await writeMarker(mine);
}

export async function pullSaves(): Promise<void> {
	const all = await listSaves();
	await switchSaveFolder(all);
	const remote = ownRemote(all);
	const dir = await savesDir();
	if (remote.length === 0 && PREFIX) {
		// first time on this link: start from the old saves (slots + settings);
		// the sync loop then sends them up under this link's names
		const local = await readLocal();
		for (const r of ownRemote(all, "")) {
			if (!VANILLA.test(r.name) || local.has(r.name)) continue;
			const data = await getSave(r.cloud);
			const handle = await dir.getFileHandle(r.name, { create: true });
			const w = await handle.createWritable();
			await w.write(data);
			await w.close();
			console.log(`[saves] started this link from your save ${r.name}`);
		}
		cloudState.lastSaved = "loaded";
		return;
	}
	const local = await readLocal();

	for (const r of remote) {
		const l = local.get(r.name);
		if (l && l.lastModified > r.modified) {
			const [snap, rb] = await Promise.all([
				readFileRetry(l.handle),
				getSave(r.cloud),
			]);
			if (!equalBytes(snap.bytes, rb)) {
				console.log(`[saves] keeping newer browser copy of ${r.name}`);
				continue; // left unsynced on purpose: the sync loop uploads it
			}
			synced.set(r.name, { size: snap.size, lastModified: snap.lastModified });
			continue;
		}
		const data = await getSave(r.cloud);
		const handle = await dir.getFileHandle(r.name, { create: true });
		const w = await handle.createWritable();
		await w.write(data);
		await w.close();
		const written = await handle.getFile();
		synced.set(r.name, {
			size: written.size,
			lastModified: written.lastModified,
		});
		console.log(`[saves] loaded ${r.name} from the cloud`);
	}
	cloudState.lastSaved = "loaded";
}

let running = false;

const stats = { lastMs: 0, files: 0 };
export const syncStats = () => ({ ...stats });

async function syncOnce(urgent = false, keepalive = false) {
	if (running) return;
	running = true;
	const t0 = performance.now();
	try {
		const local = await readLocal();
		stats.files = local.size;
		const pending: [string, Local][] = [];
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
			const snap = await readFileRetry(file.handle);
			await putSave(PREFIX + name, snap.bytes, keepalive);
			synced.set(name, { size: snap.size, lastModified: snap.lastModified });
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
			e instanceof LockedError
				? "Password needed again, reload the page"
				: String(e);
	} finally {
		cloudState.syncing = false;
		stats.lastMs = Math.round(performance.now() - t0);
		running = false;
	}
}

let started = false;
// true once the save has been loaded and is being kept in step (used before
// handing the game to another tab, so an old copy is never sent)
export function isSaveSyncRunning() {
	return started;
}
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
export async function copySavesFromFolder(
	gameFolder: FileSystemDirectoryHandle
) {
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
export async function copySavesFromDroppedFolder(
	gameFolder: FileSystemDirectoryEntry
) {
	const read = readAllEntries;
	const saves = (await read(gameFolder)).find(
		(e) => e.isDirectory && e.name === "Saves"
	) as FileSystemDirectoryEntry | undefined;
	if (!saves) return 0;
	let n = 0;
	for (const entry of await read(saves)) {
		if (!entry.isFile || !isSyncedSave(entry.name)) continue;
		const file = await new Promise<File>((res, rej) =>
			(entry as FileSystemFileEntry).file(res, rej)
		);
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
