// One computer at a time (asked 17 Nov 2026). Afonso switches between work
// computers; a game left open on one of them kept sending its saves and could
// overwrite newer progress made on another. Now starting the game claims "the
// playing computer" in the cloud (/api/session). Every 30 s, and before any
// save is sent, a computer checks whether it is still the playing one; if not,
// it stops sending saves, pauses the game and offers "Play here", which claims
// it back and reloads (to pick up the newest saves from the cloud).
import { call } from "./cloud";
import { gameState, setAway } from "./game/dotnet";

const id = (crypto as any).randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
let claimed = false;
let lost = false;
let lastCheck = 0;
let checking: Promise<boolean> | null = null;

const device = () => {
	const ua = navigator.userAgent;
	const os = /CrOS/.test(ua) ? "Chromebook" : /Windows/.test(ua) ? "Windows PC" : /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : "computer";
	return os;
};

// the hidden test links use throwaway saves and must never take over
const testing = /^test/.test(new URLSearchParams(location.search).get("mods") || "");

export async function claimPlaying() {
	if (testing) return;
	try {
		await call("session", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id, device: device() }),
		});
		claimed = true;
		lost = false;
		lastCheck = Date.now();
		console.log("[session] this computer is now the one playing");
	} catch (e) {
		// no network: keep playing; the next check decides
		console.warn("[session] could not claim:", e);
	}
}

// true while this computer may send saves. Network problems count as yes.
export function stillPlaying(maxAgeMs = 5000): Promise<boolean> {
	if (!claimed) return Promise.resolve(true); // the game has not started here
	if (lost) return Promise.resolve(false);
	if (Date.now() - lastCheck < maxAgeMs) return Promise.resolve(true);
	if (checking) return checking;
	checking = (async () => {
		try {
			const s = await (await call("session")).json();
			lastCheck = Date.now();
			if (s?.id && s.id !== id) {
				lost = true;
				onLost(s);
				return false;
			}
			return true;
		} catch {
			return true;
		} finally {
			checking = null;
		}
	})();
	return checking;
}

function onLost(s: { device?: string; time?: number }) {
	console.warn(`[session] Celeste was opened on another ${s.device || "computer"}: stopped sending saves here`);
	try {
		if (gameState.playing) setAway(true); // pause the level and hold the clock
	} catch {}
	const box = document.createElement("div");
	box.style.cssText =
		"position:fixed;inset:0;z-index:120;display:flex;flex-direction:column;gap:1.1rem;align-items:center;justify-content:center;text-align:center;padding:1.5rem;background:rgba(0,0,0,0.88);color:#fff;font:600 1.15rem system-ui,sans-serif;";
	const when = s.time ? new Date(s.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
	const text = document.createElement("div");
	text.textContent = `Celeste was opened on another ${s.device || "computer"}${when ? " at " + when : ""}. This one stopped sending saves, so it cannot overwrite that progress.`;
	const button = document.createElement("button");
	button.textContent = "Play here";
	button.style.cssText =
		"font:700 1.25rem system-ui,sans-serif;padding:0.8rem 2.2rem;border-radius:0.8rem;border:none;background:#fff;color:#000;cursor:pointer;";
	button.onclick = async () => {
		button.disabled = true;
		button.textContent = "Taking over...";
		await claimPlaying();
		// reload, so this computer starts from the newest saves in the cloud
		const u = new URL(location.href);
		u.searchParams.set("autoplay", "1");
		location.replace(u.toString());
	};
	box.append(text, button);
	document.body.append(box);
}

// check every 30 s while the game runs, so a computer left open notices soon
setInterval(() => {
	if (claimed && !lost && !document.hidden) stillPlaying(0);
}, 30000);
document.addEventListener("visibilitychange", () => {
	if (!document.hidden && claimed && !lost) stillPlaying(0);
});
