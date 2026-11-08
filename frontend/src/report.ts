// Sends this page's errors to the site's cloud storage (added 8 Nov 2026), so a
// problem on a phone can be read there without copying anything off the screen.
// Sent in small batches; never more than 40 entries per page load.
import { profile } from "./profile";

type Entry = { time: string; step: string; message: string; device: string; link: string; build: string };

// which version of the site this page is (shown on the loading screen too)
export const BUILD = (import.meta.env.VITE_BUILD_ID || "dev").slice(0, 7);

const queue: Entry[] = [];
let sent = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
const MAX = 40;

const device = () => {
	const nav = navigator as any;
	const mem = nav.deviceMemory ? ` mem=${nav.deviceMemory}GB` : "";
	return navigator.userAgent.slice(0, 220) + mem;
};

function text(e: unknown): string {
	if (e instanceof Error) return `${e.name}: ${e.message}\n${(e.stack || "").slice(0, 1500)}`;
	if (typeof e === "string") return e;
	try {
		return JSON.stringify(e);
	} catch {
		return String(e);
	}
}

async function flush() {
	timer = null;
	if (!queue.length) return;
	const entries = queue.splice(0, queue.length);
	try {
		const { call } = await import("./cloud");
		await call("report", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ entries }),
			keepalive: true,
		});
	} catch {
		// not logged in yet, or offline: nothing to do
	}
}

export function report(step: string, e: unknown) {
	if (sent >= MAX) return;
	sent++;
	queue.push({
		time: new Date().toISOString(),
		step,
		message: text(e).slice(0, 3000),
		device: device(),
		link: profile?.id ?? "none",
		build: BUILD,
	});
	if (!timer) timer = setTimeout(flush, 1500);
}

// anything the page or the game prints as an error
const original = console.error.bind(console);
console.error = (...args: unknown[]) => {
	original(...args);
	try {
		report("console", args.map(text).join(" "));
	} catch {}
};
// the game prints some of its errors as ordinary lines ("error init()!")
const ERRORISH = /error|exception|fail/i;
for (const level of ["log", "warn", "info"] as const) {
	const orig = console[level].bind(console);
	console[level] = (...args: unknown[]) => {
		orig(...args);
		try {
			const line = args.map(text).join(" ");
			if (ERRORISH.test(line) && !line.startsWith("[saves]")) report("console." + level, line);
		} catch {}
	};
}
addEventListener("error", (e) => report("page", (e as ErrorEvent).error || (e as ErrorEvent).message));
addEventListener("unhandledrejection", (e) => report("promise", (e as PromiseRejectionEvent).reason));
addEventListener("pagehide", () => flush());
