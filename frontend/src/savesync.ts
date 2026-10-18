// Keeps the game's save folder (Celeste/Saves in browser storage) in step with
// the "saves" folder in Google Drive.
//
// - Before the game starts, pullSaves() brings the Drive saves into the browser.
//   If a save in the browser is newer than Drive's copy (it was written after
//   the Google sign-in ran out, for example), the browser copy wins and is sent
//   up instead.
// - While the page is open, every changed save is sent to Drive a few seconds
//   after the game finishes writing it. Before a Drive save is overwritten, its
//   previous version is copied to "save-backups"; only the newest 3 backups per
//   save file are kept (older ones go to the Drive bin).
import { rootFolder } from "./fs";
import {
	copyFile,
	downloadFile,
	DriveAuthError,
	DriveFile,
	driveState,
	getFolders,
	listFiles,
	trashFile,
	uploadSmall,
} from "./drive";

const SAVES_PATH = ["Celeste", "Saves"];
const KEEP_BACKUPS = 3;
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
// what the browser file looked like when it last matched Drive
const synced = new Map<string, Seen>();
// last observation, used to wait until the game has finished writing
const lastSeen = new Map<string, Seen>();
const driveIds = new Map<string, string>();

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

export async function hasDriveSaves(): Promise<boolean> {
	const f = await getFolders();
	const files = await listFiles(f.saves);
	return files.some((x) => isSyncedSave(x.name));
}

export async function pullSaves(): Promise<void> {
	const f = await getFolders();
	const remote = (await listFiles(f.saves)).filter((x) => isSyncedSave(x.name));
	const local = await readLocal();
	const dir = await savesDir();

	for (const r of remote) {
		driveIds.set(r.name, r.id);
		const l = local.get(r.name);
		const remoteTime = Date.parse(r.modifiedTime);
		if (l && l.lastModified > remoteTime) {
			const [lt, rt] = await Promise.all([
				l.text(),
				downloadFile(r.id).then((x) => x.text()),
			]);
			if (lt !== rt) {
				console.log(`[saves] keeping newer browser copy of ${r.name}`);
				continue; // left unsynced on purpose: the sync loop uploads it
			}
			synced.set(r.name, { size: l.size, lastModified: l.lastModified });
			continue;
		}
		const data = await downloadFile(r.id).then((x) => x.arrayBuffer());
		const handle = await dir.getFileHandle(r.name, { create: true });
		const w = await handle.createWritable();
		await w.write(data);
		await w.close();
		const written = await handle.getFile();
		synced.set(r.name, { size: written.size, lastModified: written.lastModified });
		console.log(`[saves] loaded ${r.name} from Google Drive`);
	}
	driveState.lastSaved = "loaded";
}

async function backupThenUpload(name: string, file: File, keepalive = false) {
	const f = await getFolders();
	const existing = driveIds.get(name);
	if (existing && !keepalive) {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		await copyFile(existing, `${name} ${stamp}`, f.backups);
		await pruneBackups(name);
	}
	const res: DriveFile = await uploadSmall(name, f.saves, file, existing, keepalive);
	driveIds.set(name, res.id);
}

async function pruneBackups(name: string) {
	const f = await getFolders();
	const all = (await listFiles(f.backups))
		.filter((x) => x.name.startsWith(name + " "))
		.sort((a, b) => Date.parse(b.createdTime) - Date.parse(a.createdTime));
	for (const old of all.slice(KEEP_BACKUPS)) {
		await trashFile(old.id);
	}
}

let running = false;

async function syncOnce(urgent = false) {
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
		driveState.waiting = pending.length;
		if (pending.length === 0) return;
		if (driveState.expired) return;

		driveState.syncing = true;
		for (const [name, file] of pending) {
			await backupThenUpload(name, file, urgent);
			synced.set(name, { size: file.size, lastModified: file.lastModified });
			console.log(`[saves] sent ${name} to Google Drive`);
		}
		driveState.waiting = 0;
		driveState.lastSaved = new Date().toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
		});
		driveState.error = "";
	} catch (e) {
		if (!(e instanceof DriveAuthError)) {
			console.error("[saves] sync failed:", e);
			driveState.error = String(e);
		}
	} finally {
		driveState.syncing = false;
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
		if (document.visibilityState === "hidden") syncOnce(true);
	});
	window.addEventListener("pagehide", () => syncOnce(true));
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

