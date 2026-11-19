// Memory clean-ups you can see (asked 19 Nov 2026).
// - every clean-up (at a death, room change, pause, or asked by hand) shows a
//   small note in the corner for 2.5 s: "Cleaned memory: 480 -> 375 MB, 84 ms"
// - "Clean memory now" in the menu, or F8 while playing, runs one on purpose;
//   the game stops for that moment and a "Cleaning memory..." box is shown
import { cleanMemoryNow, gameState } from "./game/dotnet";

const note = document.createElement("div");
note.style.cssText =
	"position:fixed;right:0.6rem;bottom:0.6rem;z-index:95;display:none;padding:0.35rem 0.7rem;border-radius:0.45rem;background:rgba(0,0,0,0.75);color:#fff;font:600 0.85rem system-ui,sans-serif;pointer-events:none;";
const box = document.createElement("div");
box.style.cssText =
	"position:fixed;inset:0;z-index:96;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);color:#fff;font:700 1.4rem system-ui,sans-serif;pointer-events:none;";
box.textContent = "Cleaning memory...";
document.body.append(note, box);

let hideAt = 0;
function show(text: string) {
	note.textContent = text;
	note.style.display = "block";
	hideAt = performance.now() + 2500;
	setTimeout(() => {
		if (performance.now() >= hideAt) note.style.display = "none";
	}, 2600);
}

window.addEventListener("my-celeste-cleanup", (e) => {
	const line = String((e as CustomEvent).detail || "");
	const m = /(\d+) -> (\d+) MB in (\d+) ms/.exec(line);
	if (m) show(`Cleaned memory: ${m[1]} -> ${m[2]} MB, ${m[3]} ms`);
});

let busy = false;
export async function cleanNow() {
	if (busy) return;
	busy = true;
	box.style.display = "flex";
	// let the box draw before the game stops
	await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
	try {
		const r = await cleanMemoryNow();
		if (!/->/.test(r)) show("Clean memory: " + r);
	} finally {
		box.style.display = "none";
		busy = false;
	}
}

window.addEventListener("keydown", (e) => {
	if (e.code === "F8" && gameState.playing) {
		e.preventDefault();
		cleanNow();
	}
});
