// Auto-pause and the health report (9 Nov 2026).
//
// Auto-pause: the game runs in a background thread, so it kept running (and
// counting time) with the tab hidden or nobody playing. Now the game is told
// you are away when:
//   - the tab goes to the background, or
//   - no game key was pressed for 30 seconds (see GAME_KEYS).
// The game then pauses the level itself, saves (the page sends that save to
// the cloud right away), and holds its clock (file time, chapter time played,
// run time) until a game key is pressed again.
//
// Health report: once a minute while playing, frame rate, memory and the
// game's memory clean-ups go to the cloud (meta key "health"), to find why it
// gets choppy after a while.
import { frameInfo, gameState, sceneInfo, setAway, wasmMemoryMB } from "./game/dotnet";
import { report } from "./report";
import { nudgeSaveSync, syncStats } from "./savesync";

const IDLE_MS = 30_000;

let lastInput = Date.now();
let isAway = false;

// Only these keys count as playing (asked 10 Nov 2026): W A S D, - and . (and
// the key that types "-" on a Portuguese keyboard), space, both shifts, tab,
// esc. Mouse, wheel, fullscreen and switching to the tab do not count, and a
// key only counts while the tab has focus. A controller counts too.
const GAME_KEYS = new Set([
	"KeyW", "KeyA", "KeyS", "KeyD",
	"Minus", "Slash", "Period", "NumpadSubtract", "NumpadDecimal",
	"Space", "ShiftLeft", "ShiftRight", "Tab", "Escape",
]);
const played = () => {
	if (document.hidden || !document.hasFocus()) return;
	lastInput = Date.now();
	if (isAway) {
		isAway = false;
		setAway(false);
	}
};
addEventListener(
	"keydown",
	(e: KeyboardEvent) => {
		if (!GAME_KEYS.has(e.code)) return;
		played();
	},
	{ capture: true, passive: true }
);

// controllers have no events for button presses: compare their state
let padSig = "";
function pollPads() {
	try {
		const sig = [...(navigator.getGamepads?.() || [])]
			.filter(Boolean)
			.map((p) => p!.buttons.map((b) => (b.pressed ? 1 : 0)).join("") + p!.axes.map((a) => Math.round(a * 4)).join(","))
			.join("|");
		if (sig !== padSig) {
			const first = padSig === "";
			padSig = sig;
			if (!first) played();
		}
	} catch {}
}

// Idle: tell the game once; the game itself pauses the level, holds its clock
// and saves (loader/Celeste.cs WatchScene), and the save goes to the cloud as
// soon as it is written (savesync.ts nudgeSaveSync). No key is pressed: a key
// press does not get through in a hidden or slowed tab (12 Nov 2026).
function autoPause(_canvas: HTMLCanvasElement, why: string) {
	if (!gameState.playing || isAway) return;
	isAway = true;
	setAway(true);
	console.log(`[away] idle (${why}): the game pauses and saves`);
	// send the save even if the "finished writing" signal is missed
	setTimeout(nudgeSaveSync, 2500);
}

export function startAwayWatch(canvas: HTMLCanvasElement) {
	document.addEventListener("visibilitychange", () => {
		// coming back to the tab does not unfreeze: a game key does
		if (document.hidden) autoPause(canvas, "tab in the background");
	});
	setInterval(() => {
		pollPads();
		if (document.hidden) autoPause(canvas, "tab in the background");
		else if (Date.now() - lastInput > IDLE_MS) autoPause(canvas, "nothing pressed for 30 s");
	}, 1000);

	// health, once a minute while playing
	let last = { ...sceneInfo, t: performance.now() };
	// lowest fps seen each second during the minute (shows the hitches)
	let lowFps = Infinity;
	let worstStall = 0;
	setInterval(() => {
		if (!gameState.playing || document.hidden) return;
		if (frameInfo.fps > 0) lowFps = Math.min(lowFps, frameInfo.fps);
		worstStall = Math.max(worstStall, frameInfo.worstMs);
	}, 250);
	setInterval(() => {
		if (!gameState.playing) return;
		const now = { ...sceneInfo, t: performance.now() };
		const mins = (now.t - last.t) / 60000;
		const sync = syncStats();
		const heap = (performance as any).memory?.usedJSHeapSize;
		report(
			"health",
			[
				`fps ${gameState.fps}${lowFps !== Infinity ? ` (lowest ${lowFps}, longest frame ${worstStall} ms)` : ""}`,
				`scene ${["menu", "level", "paused"][now.state] ?? now.state}`,
				`game memory ${now.managedMB} MB of ${wasmMemoryMB()} MB`,
				`cleanups/min gen0 ${((now.gen0 - last.gen0) / mins).toFixed(1)} gen1 ${((now.gen1 - last.gen1) / mins).toFixed(1)} gen2 ${((now.gen2 - last.gen2) / mins).toFixed(1)}`,
				`cleanup pause ${Math.round((now.gcPauseMs - last.gcPauseMs) / mins)} ms/min`,
				`save check ${sync.lastMs} ms (${sync.files} files), game saves ${now.saves - last.saves}`,
				heap ? `page memory ${Math.round(heap / 1048576)} MB` : "",
				document.hidden ? "tab hidden" : "",
			]
				.filter(Boolean)
				.join(", ")
		);
		last = now;
		lowFps = Infinity;
		worstStall = 0;
	}, 60_000);
}
