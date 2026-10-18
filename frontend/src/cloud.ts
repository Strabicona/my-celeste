// Talks to the site's own storage (Cloudflare, behind the site password).
// The password cookie is sent automatically with every request, so nothing
// here deals with sign-in. Data travels as base64 text (see functions/_middleware.ts).

export const cloudState: Stateful<{
	syncing: boolean;
	waiting: number;
	lastSaved: string;
	error: string;
}> = $state({
	syncing: false,
	waiting: 0,
	lastSaved: "",
	error: "",
});
(globalThis as any).cloudState = cloudState;

export class LockedError extends Error {
	constructor() {
		super("The site password is needed again");
	}
}

// Where the locked storage lives. The GitHub Pages copy of the site calls the
// Cloudflare copy's storage; the access token comes from the password check.
const API_BASE: string = (import.meta.env.VITE_API_BASE || "").replace(/\/$/, "");
const TOKEN_KEY = "my-celeste-access";

function readToken(): string | null {
	try {
		return localStorage.getItem(TOKEN_KEY);
	} catch {
		return null;
	}
}

export function hasAccess(): boolean {
	return !!readToken();
}

export async function unlock(password: string): Promise<boolean> {
	const res = await fetch(API_BASE + "/api/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ password }),
	});
	if (!res.ok) return false;
	const { token } = (await res.json()) as { token: string };
	try {
		localStorage.setItem(TOKEN_KEY, token);
	} catch {}
	return true;
}

function forget() {
	try {
		localStorage.removeItem(TOKEN_KEY);
	} catch {}
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	const token = readToken();
	if (token) headers.set("Authorization", "Bearer " + token);
	const res = await fetch(API_BASE + "/api/" + path, { ...init, headers });
	if (res.status === 401) {
		forget();
		throw new LockedError();
	}
	if (!res.ok) {
		throw new Error(`Storage error ${res.status}: ${await res.text()}`);
	}
	return res;
}

// --- base64 helpers ----------------------------------------------------------

export function toBase64(bytes: Uint8Array): string {
	const anyU8 = Uint8Array.prototype as any;
	if (typeof anyU8.toBase64 === "function") return (bytes as any).toBase64();
	let out = "";
	const step = 0x8000;
	for (let i = 0; i < bytes.length; i += step) {
		out += String.fromCharCode(...bytes.subarray(i, i + step));
	}
	return btoa(out);
}

export function fromBase64(text: string): Uint8Array {
	const anyU8 = Uint8Array as any;
	if (typeof anyU8.fromBase64 === "function") return anyU8.fromBase64(text);
	const bin = atob(text);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

// --- saves -------------------------------------------------------------------

export type CloudSave = { name: string; modified: number };

export async function listSaves(): Promise<CloudSave[]> {
	return (await call("saves")).json();
}

export async function getSave(name: string): Promise<Uint8Array> {
	return fromBase64(await (await call("saves/" + encodeURIComponent(name))).text());
}

export async function putSave(
	name: string,
	data: Uint8Array,
	keepalive = false
): Promise<CloudSave> {
	const body = toBase64(data);
	const res = await call("saves/" + encodeURIComponent(name), {
		method: "PUT",
		headers: { "Content-Type": "text/plain" },
		body,
		keepalive: keepalive && body.length < 60_000,
	});
	return res.json();
}

// --- game archive ------------------------------------------------------------

export const PIECE = 1_400_000; // bytes per stored piece (base64 stays under 2 MB)

export type GameInfo = { version: string; pieces: number; size: number; uploaded: number };

export async function gameInfo(): Promise<GameInfo | null> {
	return (await call("game/info")).json();
}

export async function startGameUpload() {
	await call("game/start", { method: "POST" });
}

export async function putPiece(version: string, index: number, data: Uint8Array) {
	const body = toBase64(data);
	for (let attempt = 0; ; attempt++) {
		try {
			await call(`game/piece/${version}/${index}`, {
				method: "PUT",
				headers: { "Content-Type": "text/plain" },
				body,
			});
			return;
		} catch (e) {
			if (e instanceof LockedError || attempt >= 4) throw e;
			await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
		}
	}
}

export async function getPiece(version: string, index: number): Promise<Uint8Array> {
	for (let attempt = 0; ; attempt++) {
		try {
			return fromBase64(await (await call(`game/piece/${version}/${index}`)).text());
		} catch (e) {
			if (e instanceof LockedError || attempt >= 4) throw e;
			await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
		}
	}
}

export async function commitGame(info: { version: string; pieces: number; size: number }) {
	await call("game/commit", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(info),
	});
}
