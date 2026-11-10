// After 8 hours of the game open (counted from pressing Play), the game does
// Save & Quit like the pause menu, the save is sent to the cloud, and the page
// reloads into a "Relaunch" screen. The reload gives all the game's memory back,
// so the next session starts clean; the downloaded files stay on the device.
import { gameState, sceneInfo, saveAndQuit } from "./game/dotnet";
import { syncNow } from "./savesync";
import { report } from "./report";

const LIMIT_MS = 8 * 60 * 60 * 1000;
const PARAM = "relaunch";

function overlay(): HTMLDivElement {
	const el = document.createElement("div");
	el.style.cssText =
		"position:fixed;inset:0;z-index:110;display:flex;flex-direction:column;gap:1.2rem;align-items:center;justify-content:center;text-align:center;padding:1.5rem;background:rgba(0,0,0,0.85);color:#fff;font:600 1.2rem system-ui,sans-serif;";
	document.body.append(el);
	return el;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function closeForRelaunch() {
	const box = overlay();
	box.textContent = "8 hours of play: saving and closing the game...";
	const savesBefore = sceneInfo.saves;
	let result = "";
	try {
		result = await saveAndQuit();
	} catch (e) {
		result = "error: " + e;
	}
	// inside a level: wait for the game to finish writing and leave the level
	if (result === "level") {
		const until = Date.now() + 30000;
		while (Date.now() < until && !(sceneInfo.saves > savesBefore && sceneInfo.state === 0)) await sleep(250);
		await sleep(1000);
	}
	try {
		await syncNow();
	} catch {}
	report("relaunch", `8 h up: ${result}, saves written ${sceneInfo.saves - savesBefore}`);
	await sleep(1500); // let the report go out
	const url = new URL(location.href);
	url.searchParams.set(PARAM, "1");
	location.replace(url.toString());
}

export function setupRelaunch(startGame: () => void) {
	// the timer: starts when Play is pressed
	let startedAt = 0;
	let closing = false;
	useChange([gameState.playing], () => {
		if (gameState.playing && !startedAt) startedAt = Date.now();
	});
	setInterval(() => {
		if (!startedAt || closing || !gameState.playing) return;
		if (Date.now() - startedAt >= LIMIT_MS) {
			closing = true;
			closeForRelaunch();
		}
	}, 30000);

	// the screen after the reload
	const params = new URLSearchParams(location.search);
	if (!params.has(PARAM)) return;
	const u = new URL(location.href);
	u.searchParams.delete(PARAM);
	history.replaceState(null, "", u.toString());

	const box = overlay();
	const text = document.createElement("div");
	text.textContent = "The game ran for 8 hours, so it was saved and closed.";
	const button = document.createElement("button");
	button.textContent = "Relaunch";
	button.style.cssText =
		"font:700 1.3rem system-ui,sans-serif;padding:0.8rem 2.2rem;border-radius:0.8rem;border:none;background:#fff;color:#000;cursor:pointer;";
	box.append(text, button);
	button.onclick = () => {
		box.remove();
		if (gameState.ready && !gameState.playing) {
			startGame();
			return;
		}
		let done = false;
		useChange([gameState.ready], () => {
			if (done || !gameState.ready || gameState.playing) return;
			done = true;
			startGame();
		});
	};
}
