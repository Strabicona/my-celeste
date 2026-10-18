// Google Drive storage for my-celeste.
//
// The game files and the save files live in a folder in the owner's Google
// Drive. The site only asks for the `drive.file` permission, so it can see and
// change ONLY the files it created itself, nothing else in the Drive.
//
// Sign-in uses Google's plain OAuth "token" redirect flow instead of the Google
// sign-in library: the game page runs with strict isolation headers (needed for
// multithreading), which break the library's popup. Google sends the user back
// to /auth/, a small page without those headers, which stores the token in
// localStorage and returns to the game page (or closes, when it was a popup).

const CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

export const ROOT_FOLDER_NAME = "My Celeste";
export const GAME_FILE_NAME = "celeste-game.tar";
export const SAVES_FOLDER_NAME = "saves";
export const BACKUPS_FOLDER_NAME = "save-backups";

const TOKEN_KEY = "my-celeste-token";
const STATE_KEY = "my-celeste-auth-state";
const FOLDER_MIME = "application/vnd.google-apps.folder";

export const driveState: Stateful<{
	signedIn: boolean;
	expired: boolean;
	syncing: boolean;
	waiting: number;
	lastSaved: string;
	error: string;
}> = $state({
	signedIn: false,
	expired: false,
	syncing: false,
	waiting: 0,
	lastSaved: "",
	error: "",
});
(globalThis as any).driveState = driveState;

export class DriveAuthError extends Error {
	constructor() {
		super("Google sign-in expired");
	}
}

type Token = { token: string; expiresAt: number };

function readToken(): Token | null {
	try {
		const raw = localStorage.getItem(TOKEN_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Token;
		if (!parsed.token || !parsed.expiresAt) return null;
		return parsed;
	} catch {
		return null;
	}
}

function validToken(): string | null {
	const t = readToken();
	// keep a minute of margin so a request never starts with a dying token
	if (!t || t.expiresAt - 60_000 < Date.now()) return null;
	return t.token;
}

export function isConfigured(): boolean {
	return CLIENT_ID.length > 0;
}

export function hasValidToken(): boolean {
	const ok = !!validToken();
	driveState.signedIn = ok;
	if (ok) driveState.expired = false;
	return ok;
}

function authUrl(mode: "redirect" | "popup"): string {
	const state = mode + "." + crypto.randomUUID();
	try {
		localStorage.setItem(STATE_KEY, state);
	} catch {}
	const redirect = new URL("auth/", location.href);
	redirect.search = "";
	redirect.hash = "";
	const params = new URLSearchParams({
		client_id: CLIENT_ID,
		redirect_uri: redirect.href,
		response_type: "token",
		scope: SCOPE,
		include_granted_scopes: "true",
		state,
	});
	return "https://accounts.google.com/o/oauth2/v2/auth?" + params;
}

// Full-page sign-in, used on the start screen before the game loads.
export function signInRedirect() {
	try {
		sessionStorage.setItem("my-celeste-return", location.href);
	} catch {}
	location.assign(authUrl("redirect"));
}

// Popup sign-in, used to reconnect while the game is running (a page reload
// would lose the running game). Resolves once the popup has stored a new token.
export function signInPopup(): Promise<void> {
	const url = authUrl("popup");
	window.open(url, "my-celeste-google", "width=500,height=650");
	return new Promise((resolve) => {
		const check = () => {
			if (hasValidToken()) {
				window.removeEventListener("storage", onStorage);
				clearInterval(timer);
				resolve();
			}
		};
		const onStorage = (e: StorageEvent) => {
			if (e.key === TOKEN_KEY) check();
		};
		window.addEventListener("storage", onStorage);
		const timer = setInterval(check, 1000);
	});
}

window.addEventListener("storage", (e) => {
	if (e.key === TOKEN_KEY) hasValidToken();
});

async function driveFetch(url: string, init: RequestInit = {}): Promise<Response> {
	const token = validToken();
	if (!token) {
		driveState.signedIn = false;
		driveState.expired = true;
		throw new DriveAuthError();
	}
	const headers = new Headers(init.headers);
	headers.set("Authorization", "Bearer " + token);
	const res = await fetch(url, { ...init, headers });
	if (res.status === 401) {
		try {
			localStorage.removeItem(TOKEN_KEY);
		} catch {}
		driveState.signedIn = false;
		driveState.expired = true;
		throw new DriveAuthError();
	}
	return res;
}

async function driveJson<T>(url: string, init: RequestInit = {}): Promise<T> {
	const res = await driveFetch(url, init);
	if (!res.ok) {
		throw new Error(`Google Drive error ${res.status}: ${await res.text()}`);
	}
	return (await res.json()) as T;
}

export type DriveFile = {
	id: string;
	name: string;
	modifiedTime: string;
	createdTime: string;
	size?: string;
};

const FILE_FIELDS = "id,name,modifiedTime,createdTime,size";

function q(s: string) {
	return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export async function listFiles(parentId: string): Promise<DriveFile[]> {
	const out: DriveFile[] = [];
	let pageToken = "";
	do {
		const params = new URLSearchParams({
			q: `'${q(parentId)}' in parents and trashed=false`,
			fields: `nextPageToken,files(${FILE_FIELDS})`,
			pageSize: "1000",
			spaces: "drive",
		});
		if (pageToken) params.set("pageToken", pageToken);
		const res = await driveJson<{ files: DriveFile[]; nextPageToken?: string }>(
			`${API}/files?${params}`
		);
		out.push(...res.files);
		pageToken = res.nextPageToken || "";
	} while (pageToken);
	return out;
}

async function findChild(
	name: string,
	parentId: string | null,
	folder: boolean
): Promise<DriveFile | null> {
	let query = `name='${q(name)}' and trashed=false`;
	query += folder
		? ` and mimeType='${FOLDER_MIME}'`
		: ` and mimeType!='${FOLDER_MIME}'`;
	if (parentId) query += ` and '${q(parentId)}' in parents`;
	const params = new URLSearchParams({
		q: query,
		fields: `files(${FILE_FIELDS})`,
		orderBy: "modifiedTime desc",
		spaces: "drive",
	});
	const res = await driveJson<{ files: DriveFile[] }>(`${API}/files?${params}`);
	return res.files[0] || null;
}

async function ensureFolder(name: string, parentId: string | null): Promise<string> {
	const existing = await findChild(name, parentId, true);
	if (existing) return existing.id;
	const created = await driveJson<DriveFile>(`${API}/files?fields=id`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			name,
			mimeType: FOLDER_MIME,
			parents: parentId ? [parentId] : undefined,
		}),
	});
	return created.id;
}

export type Folders = { root: string; saves: string; backups: string };
let folders: Folders | null = null;

export async function getFolders(): Promise<Folders> {
	if (folders) return folders;
	const root = await ensureFolder(ROOT_FOLDER_NAME, null);
	const [saves, backups] = await Promise.all([
		ensureFolder(SAVES_FOLDER_NAME, root),
		ensureFolder(BACKUPS_FOLDER_NAME, root),
	]);
	folders = { root, saves, backups };
	return folders;
}

export async function findGameFile(): Promise<DriveFile | null> {
	const f = await getFolders();
	return await findChild(GAME_FILE_NAME, f.root, false);
}

export async function downloadFile(id: string): Promise<Response> {
	const res = await driveFetch(`${API}/files/${encodeURIComponent(id)}?alt=media`);
	if (!res.ok) {
		throw new Error(`Google Drive download error ${res.status}: ${await res.text()}`);
	}
	return res;
}

// Small files (saves): create, or replace the contents of an existing file.
export async function uploadSmall(
	name: string,
	parentId: string,
	data: Blob,
	existingId?: string,
	keepalive = false
): Promise<DriveFile> {
	if (existingId) {
		return await driveJson<DriveFile>(
			`${UPLOAD_API}/files/${encodeURIComponent(existingId)}?uploadType=media&fields=${FILE_FIELDS}`,
			{
				method: "PATCH",
				headers: { "Content-Type": "application/octet-stream" },
				body: data,
				keepalive: keepalive && data.size < 60_000,
			}
		);
	}
	const boundary = "mycel" + crypto.randomUUID().replace(/-/g, "");
	const meta = JSON.stringify({ name, parents: [parentId] });
	const body = new Blob([
		`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
		`--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
		data,
		`\r\n--${boundary}--`,
	]);
	return await driveJson<DriveFile>(
		`${UPLOAD_API}/files?uploadType=multipart&fields=${FILE_FIELDS}`,
		{
			method: "POST",
			headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
			body,
			keepalive: keepalive && body.size < 60_000,
		}
	);
}

export async function copyFile(id: string, name: string, parentId: string) {
	return await driveJson<DriveFile>(
		`${API}/files/${encodeURIComponent(id)}/copy?fields=${FILE_FIELDS}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name, parents: [parentId] }),
		}
	);
}

// Moves a file to the Drive bin (recoverable for 30 days), never a hard delete.
export async function trashFile(id: string) {
	await driveJson(`${API}/files/${encodeURIComponent(id)}?fields=id`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ trashed: true }),
	});
}

// Large uploads (the game archive): Google's resumable upload, sent in chunks
// so a ~1 GB file never has to sit in memory at once.
const CHUNK = 32 * 1024 * 1024; // must be a multiple of 256 KiB

export async function uploadLarge(
	name: string,
	parentId: string,
	stream: ReadableStream<Uint8Array>,
	onProgress: (bytes: number) => void
): Promise<DriveFile> {
	const start = await driveFetch(`${UPLOAD_API}/files?uploadType=resumable&fields=${FILE_FIELDS}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json; charset=UTF-8",
			"X-Upload-Content-Type": "application/x-tar",
		},
		body: JSON.stringify({ name, parents: [parentId] }),
	});
	if (!start.ok) {
		throw new Error(`Google Drive upload error ${start.status}: ${await start.text()}`);
	}
	const session = start.headers.get("Location");
	if (!session) throw new Error("Google Drive did not return an upload address");

	const reader = stream.getReader();
	let buffer = new Uint8Array(CHUNK);
	let filled = 0;
	let sent = 0;
	let done = false;

	while (!done) {
		// fill one chunk
		while (filled < CHUNK) {
			const { value, done: end } = await reader.read();
			if (end || !value) {
				done = true;
				break;
			}
			let offset = 0;
			while (offset < value.length) {
				const n = Math.min(CHUNK - filled, value.length - offset);
				buffer.set(value.subarray(offset, offset + n), filled);
				filled += n;
				offset += n;
				if (filled === CHUNK && offset < value.length) {
					await sendChunk(false);
				}
			}
		}
		await sendChunk(done);
	}

	return lastResult!;

	async function sendChunk(final: boolean) {
		const body = buffer.slice(0, filled);
		const end = sent + filled - 1;
		const total = final ? String(sent + filled) : "*";
		const range =
			filled > 0 ? `bytes ${sent}-${end}/${total}` : `bytes */${total}`;
		for (let attempt = 0; ; attempt++) {
			// XMLHttpRequest, as in Google's own browser upload sample: it hands
			// back the "308 resume incomplete" answers untouched.
			const result = await new Promise<{ status: number; text: string }>((resolve) => {
				const xhr = new XMLHttpRequest();
				xhr.open("PUT", session!);
				xhr.setRequestHeader("Content-Range", range);
				const token = validToken();
				if (token) xhr.setRequestHeader("Authorization", "Bearer " + token);
				xhr.upload.onprogress = (e) => onProgress(sent + e.loaded);
				xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
				xhr.onerror = () => resolve({ status: 0, text: "network error" });
				xhr.send(body);
			});
			if (result.status === 308 || (result.status >= 200 && result.status < 300)) {
				if (result.status !== 308) lastResult = JSON.parse(result.text) as DriveFile;
				break;
			}
			if (attempt >= 4) {
				throw new Error(`Google Drive upload error ${result.status}: ${result.text}`);
			}
			await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
		}
		sent += filled;
		filled = 0;
		onProgress(sent);
	}
}
let lastResult: DriveFile | null = null;
