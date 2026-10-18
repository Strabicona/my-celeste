// Chrome refuses to read a browser-storage file (InvalidStateError) when the
// file changed between looking it up and reading it, e.g. right after a reload
// while the game was still finishing a save. Waiting a moment and trying again
// always gets a consistent copy.

export type Snapshot = {
	bytes: Uint8Array;
	size: number;
	lastModified: number;
};

const TRIES = 8;
const WAIT_MS = 400;

export async function readFileRetry(
	handle: FileSystemFileHandle
): Promise<Snapshot> {
	for (let attempt = 1; ; attempt++) {
		try {
			const file = await handle.getFile();
			const bytes = new Uint8Array(await file.arrayBuffer());
			return { bytes, size: file.size, lastModified: file.lastModified };
		} catch (e) {
			if ((e as DOMException)?.name === "NotFoundError" || attempt >= TRIES)
				throw e;
			console.warn(`[files] ${handle.name} busy, trying again (${attempt})`);
			await new Promise((r) => setTimeout(r, WAIT_MS));
		}
	}
}
