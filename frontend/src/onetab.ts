// One tab at a time (asked 30 Oct 2026).
//
// Two tabs of this site share the same game files in the browser's storage,
// and Chrome refuses a file one tab is using while the other reads it
// ("A game file was busy"). So the newest tab wins:
//
// - A tab that opens tells every other tab of this site.
// - Those tabs send their save first (if the game had loaded it), then reload
//   into a small "opened in another tab" screen that touches no game files,
//   with a "Play here" button to move the game back.
// - The new tab waits until the old page is really gone (the lock it held is
//   let go when the page unloads), at most a few seconds, then starts.
//
// This module is imported first by app.tsx and finishes before anything else
// in the site runs, so nothing touches the game files until it is done.

const CHANNEL = "my-celeste-tabs";
const LOCK = "my-celeste-game";
const ELSEWHERE = "my-celeste-elsewhere";
const WAIT_MS = 8000;
const SAVE_WAIT_MS = 4000;

function sessionGet(key: string): string | null {
	try {
		return sessionStorage.getItem(key);
	} catch {
		return null;
	}
}

function sessionSet(key: string, value: string | null) {
	try {
		if (value === null) sessionStorage.removeItem(key);
		else sessionStorage.setItem(key, value);
	} catch {}
}

function showElsewhere(): Promise<never> {
	const show = () => {
		document.body.innerHTML = "";
		const box = document.createElement("div");
		box.style.cssText =
			"position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1em;" +
			"background:#111;color:#eee;font:16px system-ui,sans-serif;text-align:center;padding:1em;";
		const text = document.createElement("p");
		text.textContent = "The game was opened in another tab.";
		const button = document.createElement("button");
		button.textContent = "Play here";
		button.style.cssText =
			"font:inherit;padding:0.6em 1.4em;border-radius:0.6em;border:0;background:#8a5cf6;color:#fff;cursor:pointer;";
		button.addEventListener("click", () => {
			sessionSet(ELSEWHERE, null);
			location.reload();
		});
		box.append(text, button);
		document.body.append(box);
		document.title = "My Celeste (in another tab)";
	};
	if (document.body) show();
	else document.addEventListener("DOMContentLoaded", show, { once: true });
	// never finishes: the rest of the site does not start in this tab
	return new Promise<never>(() => {});
}

async function sendSaveBeforeLeaving() {
	try {
		const saves = await import("./savesync");
		// only when this tab had loaded the save; otherwise an old copy could be sent
		if (!saves.isSaveSyncRunning()) return;
		await Promise.race([
			saves.syncNow(),
			new Promise((r) => setTimeout(r, SAVE_WAIT_MS)),
		]);
	} catch (e) {
		console.error("[tabs] could not send the save before leaving", e);
	}
}

async function takeOver() {
	const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
	let channel: BroadcastChannel | null = null;
	try {
		channel = new BroadcastChannel(CHANNEL);
	} catch {}

	// another tab opening the game: step aside
	let leaving = false;
	channel?.addEventListener("message", async (e: MessageEvent) => {
		const msg = e.data;
		if (!msg || msg.type !== "takeover" || msg.id === id || leaving) return;
		leaving = true;
		console.log("[tabs] the game was opened in another tab, stepping aside");
		await sendSaveBeforeLeaving();
		sessionSet(ELSEWHERE, "1");
		location.reload();
	});
	channel?.postMessage({ type: "takeover", id });

	// hold the lock for as long as this page lives; an older tab's lock is let
	// go when it unloads, so getting it means the old page is gone
	const locks = (navigator as any).locks;
	if (!locks?.request) return;
	const hold = () => new Promise<void>(() => {});
	await new Promise<void>((resolve) => {
		// while waiting, keep asking (a tab that Chrome had put to sleep hears it
		// as soon as it wakes up, e.g. when you click on it)
		const ask = setInterval(() => channel?.postMessage({ type: "takeover", id }), 2000);
		// the old tab has not let go after a few seconds: say so, and keep
		// waiting; the game starts by itself the moment the files are free
		let note: HTMLDivElement | null = null;
		const slow = setTimeout(() => {
			console.warn("[tabs] the other tab did not answer, waiting for it");
			note = document.createElement("div");
			note.style.cssText =
				"position:fixed;inset:0;z-index:1000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1em;" +
				"background:#111;color:#eee;font:16px system-ui,sans-serif;text-align:center;padding:1em;";
			note.innerHTML =
				"<p style='font-weight:600;font-size:1.2em;margin:0'>Celeste is still open in another tab that is not answering.</p>" +
				"<p style='margin:0'>Close that tab (or click on it once). The game starts here by itself as soon as it lets go.</p>";
			document.documentElement.append(note);
		}, WAIT_MS);
		locks
			.request(LOCK, () => {
				clearInterval(ask);
				clearTimeout(slow);
				if (note) {
					note.remove();
					console.log("[tabs] the other tab let go, starting");
				}
				resolve();
				return hold();
			})
			.catch((e: unknown) => {
				clearInterval(ask);
				clearTimeout(slow);
				note?.remove();
				console.warn("[tabs] could not wait for the other tab:", e);
				resolve();
			});
	});
}

if (sessionGet(ELSEWHERE)) await showElsewhere();
await takeOver();

export {};
