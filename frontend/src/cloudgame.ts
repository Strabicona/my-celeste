// Moves the game files between the browser's storage and Google Drive as one
// archive (Content folder + the clean Celeste.exe + the already-patched
// CustomCeleste.dll). Because the patched file travels with it, a fresh browser
// only downloads and unpacks; it never has to re-patch the game.
import { createTar, extractTar, rootFolder } from "./fs";
import {
	DriveFile,
	findGameFile,
	GAME_FILE_NAME,
	getFolders,
	trashFile,
	uploadLarge,
	downloadFile,
} from "./drive";

const GAME_ITEMS = ["Content", "Celeste.exe", "CustomCeleste.dll"];

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

export async function uploadGame(
	onProgress: (fraction: number) => void
): Promise<DriveFile> {
	const f = await getFolders();
	const old = await findGameFile();
	const total = Math.max(1, await localGameSize());
	const stream = createTar(rootFolder, undefined, GAME_ITEMS);
	const res = await uploadLarge(GAME_FILE_NAME, f.root, stream, (bytes) =>
		onProgress(Math.min(1, bytes / total))
	);
	// only one game copy is ever kept
	if (old && old.id !== res.id) await trashFile(old.id);
	return res;
}

export async function downloadGame(
	file: DriveFile,
	onProgress: (fraction: number) => void
) {
	const res = await downloadFile(file.id);
	const total = Number(file.size || res.headers.get("Content-Length") || 0);
	const reader = res.body!.getReader();
	let got = 0;
	const progress = new ReadableStream<Uint8Array>({
		async pull(controller) {
			const { value, done } = await reader.read();
			if (done || !value) {
				controller.close();
				return;
			}
			got += value.byteLength;
			if (total) onProgress(Math.min(1, got / total));
			controller.enqueue(value);
		},
	});
	await extractTar(progress, rootFolder);
	await rootFolder.getFileHandle(".ContentExists", { create: true });
}
