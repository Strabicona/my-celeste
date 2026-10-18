// Password lock + storage API for my-celeste, running on Cloudflare Pages.
//
// Every request to the site passes through here. Without the right cookie you
// only get the password page; with it you get the site, the game engine, and
// the storage API below. Storage is five free D1 databases (500 MB each on the
// free plan): the saves (with their last 3 backups) live in DB0, the game
// archive is split into 1.4 MB pieces spread across DB1-DB4.
//
// Everything is stored as base64 text: D1 hands binary columns back as plain
// number arrays, which would cost more processing time than the free plan
// allows per request. Text passes through untouched; the browser decodes it.

interface Env {
	SITE_PASSWORD?: string;
	DB0: D1Database;
	DB1: D1Database;
	DB2: D1Database;
	DB3: D1Database;
	DB4: D1Database;
	ASSETS: Fetcher;
}

type Ctx = EventContext<Env, string, unknown>;

const COOKIE = "mc_auth";
const KEEP_BACKUPS = 3;
const MAX_TEXT = 1_950_000; // D1 values are capped at 2,000,000 bytes
const SAVE_NAME = /^(\d+|settings|debug)\.celeste$/;
// the GitHub Pages copy of the site talks to this storage from another address
const ALLOWED_ORIGINS = ["https://strabicona.github.io"];
const ISOLATION = {
	"Cross-Origin-Embedder-Policy": "require-corp",
	"Cross-Origin-Opener-Policy": "same-origin",
};

const enc = new TextEncoder();

async function authToken(password: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		enc.encode("my-celeste:" + password),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);
	const sig = await crypto.subtle.sign("HMAC", key, enc.encode("signed-in"));
	return btoa(String.fromCharCode(...new Uint8Array(sig)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function timingSafeEqual(a: string, b: string) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

function readCookie(req: Request, name: string): string | null {
	const header = req.headers.get("Cookie") || "";
	for (const part of header.split(";")) {
		const [k, ...v] = part.trim().split("=");
		if (k === name) return v.join("=");
	}
	return null;
}

function withIsolation(res: Response): Response {
	const out = new Response(res.body, res);
	for (const [k, v] of Object.entries(ISOLATION)) out.headers.set(k, v);
	return out;
}

function json(data: unknown, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
	});
}

function corsHeaders(req: Request): Record<string, string> {
	const origin = req.headers.get("Origin") || "";
	if (!ALLOWED_ORIGINS.includes(origin)) return {};
	return {
		"Access-Control-Allow-Origin": origin,
		"Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
		"Access-Control-Allow-Headers": "Authorization, Content-Type",
		"Access-Control-Max-Age": "86400",
		Vary: "Origin",
	};
}

function withCors(req: Request, res: Response): Response {
	const extra = corsHeaders(req);
	const out = new Response(res.body, res);
	for (const [k, v] of Object.entries(extra)) out.headers.set(k, v);
	out.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
	return out;
}

function bearer(req: Request): string | null {
	const h = req.headers.get("Authorization") || "";
	return h.startsWith("Bearer ") ? h.slice(7) : null;
}

function loginPage(message = ""): Response {
	const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>My Celeste</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#11111b;color:#cdd6f4;font-family:system-ui,sans-serif}
form{display:flex;flex-direction:column;gap:.75rem;width:min(20rem,90vw)}
input,button{font:inherit;padding:.7rem .9rem;border-radius:.6rem;border:1px solid #45475a;background:#1e1e2e;color:inherit}
button{background:#cba6f7;color:#11111b;border:none;font-weight:600;cursor:pointer}
p{margin:0;color:#f38ba8;min-height:1.2em}
</style></head><body>
<form method="post" action="/__login">
<h1 style="margin:0 0 .5rem;font-size:1.4rem">My Celeste</h1>
<input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password" required>
<button type="submit">Enter</button>
<p>${message}</p>
</form></body></html>`;
	return new Response(html, {
		status: message ? 401 : 200,
		headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
	});
}

export const onRequest = async (ctx: Ctx): Promise<Response> => {
	const { request, env } = ctx;
	const url = new URL(request.url);
	const password = env.SITE_PASSWORD || "";

	// fail closed: no password configured means nobody gets in
	if (!password) {
		return withCors(request, new Response("Site password is not set up yet.", { status: 503 }));
	}
	const token = await authToken(password);

	if (url.pathname === "/__login" && request.method === "POST") {
		const form = await request.formData();
		const given = String(form.get("password") || "");
		if (!timingSafeEqual(await authToken(given), token)) {
			await new Promise((r) => setTimeout(r, 1500)); // slow down guessing
			return loginPage("Wrong password.");
		}
		return new Response(null, {
			status: 303,
			headers: {
				Location: "/",
				"Set-Cookie": `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=34560000`,
			},
		});
	}

	if (url.pathname.startsWith("/api/")) {
		if (request.method === "OPTIONS") {
			return withCors(request, new Response(null, { status: 204 }));
		}
		// password check for the GitHub Pages copy: returns the access token
		if (url.pathname === "/api/login" && request.method === "POST") {
			const body = (await request.json().catch(() => ({}))) as { password?: string };
			if (!timingSafeEqual(await authToken(String(body.password || "")), token)) {
				await new Promise((r) => setTimeout(r, 1500)); // slow down guessing
				return withCors(request, json({ error: "wrong password" }, 401));
			}
			return withCors(request, json({ token }));
		}
		const given = bearer(request) || readCookie(request, COOKIE);
		if (!given || !timingSafeEqual(given, token)) {
			return withCors(request, json({ error: "locked" }, 401));
		}
		try {
			return withCors(request, await api(request, env, url));
		} catch (e) {
			return withCors(request, json({ error: String(e) }, 500));
		}
	}

	const cookie = readCookie(request, COOKIE);
	if (!cookie || !timingSafeEqual(cookie, token)) {
		return loginPage();
	}

	return withIsolation(await ctx.next());
};

// ---------------------------------------------------------------- storage API

const GAME_DBS = (env: Env) => [env.DB1, env.DB2, env.DB3, env.DB4];

async function api(req: Request, env: Env, url: URL): Promise<Response> {
	const path = url.pathname.slice("/api/".length).split("/");
	const db = env.DB0;

	// --- saves ---------------------------------------------------------------
	if (path[0] === "saves" && path.length === 1 && req.method === "GET") {
		const rows = await db
			.prepare("SELECT name, modified FROM saves")
			.all<{ name: string; modified: number }>();
		return json(rows.results);
	}
	if (path[0] === "saves" && path.length === 2) {
		const name = decodeURIComponent(path[1]);
		if (!SAVE_NAME.test(name)) return json({ error: "bad name" }, 400);

		if (req.method === "GET") {
			const row = await db
				.prepare("SELECT data FROM saves WHERE name = ?")
				.bind(name)
				.first<{ data: string }>();
			if (!row) return json({ error: "not found" }, 404);
			return new Response(row.data, {
				headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
			});
		}
		if (req.method === "PUT") {
			const data = await req.text(); // base64
			if (data.length > MAX_TEXT) return json({ error: "too big" }, 413);
			const now = Date.now();
			// keep the previous version as a backup, then keep only the newest 3
			await db.batch([
				db
					.prepare(
						"INSERT INTO backups (name, data, created) SELECT name, data, ? FROM saves WHERE name = ?"
					)
					.bind(now, name),
				db
					.prepare(
						"DELETE FROM backups WHERE name = ? AND id NOT IN (SELECT id FROM backups WHERE name = ? ORDER BY created DESC, id DESC LIMIT ?)"
					)
					.bind(name, name, KEEP_BACKUPS),
				db
					.prepare(
						"INSERT INTO saves (name, data, modified) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET data = excluded.data, modified = excluded.modified"
					)
					.bind(name, data, now),
			]);
			return json({ name, modified: now });
		}
	}

	// --- game archive ------------------------------------------------------------
	if (path[0] === "game") {
		const all = GAME_DBS(env);

		if (path[1] === "info" && req.method === "GET") {
			const row = await db
				.prepare("SELECT value FROM meta WHERE key = 'game'")
				.first<{ value: string }>();
			return json(row ? JSON.parse(row.value) : null);
		}

		// GET /api/game/piece/<version>/<index>
		if (path[1] === "piece" && req.method === "GET") {
			const version = path[2];
			const index = Number(path[3]);
			const row = await all[index % all.length]
				.prepare("SELECT data FROM game_pieces WHERE version = ? AND idx = ?")
				.bind(version, index)
				.first<{ data: string }>();
			if (!row) return json({ error: "not found" }, 404);
			return new Response(row.data, {
				headers: {
					"Content-Type": "text/plain",
					"Cache-Control": "private, max-age=31536000, immutable",
				},
			});
		}

		// PUT /api/game/piece/<version>/<index>
		if (path[1] === "piece" && req.method === "PUT") {
			const version = path[2];
			const index = Number(path[3]);
			if (!/^[a-z0-9-]{4,40}$/.test(version) || !Number.isInteger(index) || index < 0)
				return json({ error: "bad piece" }, 400);
			const data = await req.text(); // base64
			if (data.length > MAX_TEXT) return json({ error: "too big" }, 413);
			await all[index % all.length]
				.prepare(
					"INSERT INTO game_pieces (version, idx, data) VALUES (?, ?, ?) ON CONFLICT(version, idx) DO UPDATE SET data = excluded.data"
				)
				.bind(version, index, data)
				.run();
			return json({ ok: true });
		}

		// POST /api/game/start: removes any old game copy before a new upload,
		// so the three databases never hold two copies at once
		if (path[1] === "start" && req.method === "POST") {
			await db.prepare("DELETE FROM meta WHERE key = 'game'").run();
			for (const d of all) {
				// delete in slices so each statement stays well inside time limits
				for (;;) {
					const res = await d
						.prepare(
							"DELETE FROM game_pieces WHERE rowid IN (SELECT rowid FROM game_pieces LIMIT 50)"
						)
						.run();
					if (!res.meta.changes) break;
				}
			}
			return json({ ok: true });
		}

		// POST /api/game/commit  body: {version, pieces, size}
		if (path[1] === "commit" && req.method === "POST") {
			const info = (await req.json()) as { version: string; pieces: number; size: number };
			await db
				.prepare(
					"INSERT INTO meta (key, value) VALUES ('game', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
				)
				.bind(JSON.stringify({ ...info, uploaded: Date.now() }))
				.run();
			return json({ ok: true });
		}
	}

	return json({ error: "not found" }, 404);
}
