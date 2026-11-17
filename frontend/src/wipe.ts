// Wipe and restart (asked 17 Nov 2026). When this computer's copy of the game
// cannot be read ("Loading your save..." keeps failing), delete everything the
// site keeps on this computer except the saves folder, then start again: the
// start-up downloads the game, Everest and the mods fresh.
//
// The saves folder (Celeste/Saves) and its marker (.SaveProfile) are kept: a
// save the game wrote but had not sent yet would otherwise be lost. The normal
// start-up then compares them with the cloud and keeps the newest.
//
// Only once per 15 minutes: if it happens again so soon, another Celeste tab
// on this computer is most likely still using the files, and wiping cannot
// help, so the caller shows that instead.
import { rootFolder } from "./fs";
import { report } from "./report";

const KEY = "my-celeste-wiped";
const KEEP_TOP = new Set([".SaveProfile"]);

export function wipedRecently(): boolean {
	try {
		return Date.now() - Number(localStorage.getItem(KEY) || 0) < 15 * 60 * 1000;
	} catch {
		return false;
	}
}

export async function wipeAndRestart(why: string) {
	try {
		localStorage.setItem(KEY, String(Date.now()));
	} catch {}
	let removed = 0;
	const failed: string[] = [];
	const remove = async (dir: FileSystemDirectoryHandle, name: string, path: string) => {
		try {
			await dir.removeEntry(name, { recursive: true });
			removed++;
		} catch (e) {
			failed.push(`${path} (${(e as DOMException)?.name ?? e})`);
		}
	};
	for await (const [name, handle] of (rootFolder as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
		if (KEEP_TOP.has(name)) continue;
		if (name === "Celeste" && handle.kind === "directory") {
			const celeste = handle as FileSystemDirectoryHandle;
			for await (const [inner] of (celeste as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
				if (inner === "Saves") continue;
				await remove(celeste, inner, "Celeste/" + inner);
			}
			continue;
		}
		await remove(rootFolder, name, name);
	}
	const msg = `wiped this computer's game files (kept the saves): ${removed} removed${failed.length ? ", could not remove " + failed.slice(0, 5).join(", ") : ""}. Reason: ${why}`;
	console.warn("[wipe] " + msg);
	report("wipe", msg);
	// let the report go out, then start again from scratch
	await new Promise((r) => setTimeout(r, 2000));
	const u = new URL(location.href);
	u.searchParams.set("autoplay", "1");
	location.replace(u.toString());
}
