// Auto-pause and the health report (9 Nov 2026).
//
// Auto-pause: the game runs in a background thread, so it kept running (and
// counting time) with the tab hidden or nobody playing. Now, while you are in a
// level and it is running, it opens the pause menu when:
//   - the tab goes to the background, or
//   - nothing was pressed for 30 seconds (keys, touch buttons, controller).
// It only presses Pause when the game says it is in a running level, so it
// never unpauses you. While away and paused, the game also holds its clock
// (file time, chapter time played, run time), until you press something again.
//
// Health report: once a minute while playing, frame rate, memory and the
// game's memory clean-ups go to the cloud (meta key "health"), to find why it
// gets choppy after a while.
import { gameState, sceneInfo, setAway, wasmMemoryMB } from "./game/dotnet";
import { loadBindings, pressPause } from "./touch";
import { report } from "./report";
import { syncStats } from "./savesync";

const IDLE_MS = 30_000;

let lastInput = Date.now();
let isAway = false;
const touched = () => {
	lastInput = Date.now();
	if (isAway && !document.hidden) {
		isAway = false;
		setAway(false);
	}
};
for (const ev of ["keydown", "keyup", "pointerdown", "pointermove", "wheel"]) {
	addEventListener(ev, touched, { capture: true, passive: true });
}

// controllers have no events for button presses: compare their state
let padSig = "";
function pollPads() {
	try {
		const sig = [...(navigator.getGamepads?.() || [])]
			.filter(Boolean)
			.map((p) => p!.buttons.map((b) => (b.pressed ? 1 : 0)).join("") + p!.axes.map((a) => Math.round(a * 4)).join(","))
			.join("|");
		if (sig !== padSig) {
			padSig = sig;
			touched();
		}
	} catch {}
}

let lastPause = 0;
function autoPause(canvas: HTMLCanvasElement, why: string) {
	if (!gameState.playing) return;
	// away: the game holds its clock while paused (file time counts in the
	// pause menu otherwise)
	if (!isAway) {
		isAway = true;
		setAway(true);
	}
	if (sceneInfo.state !== 1) return;
	if (Date.now() - lastPause < 3000) return; // give the menu time to open
	lastPause = Date.now();
	// read the Pause key from the save again, in case it was changed in the game
	loadBindings().finally(() => pressPause(canvas));
	console.log(`[away] paused the game (${why})`);
}

export function startAwayWatch(canvas: HTMLCanvasElement) {
	loadBindings();
	document.addEventListener("visibilitychange", () => {
		if (document.hidden) autoPause(canvas, "tab in the background");
		else touched();
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
	setInterval(() => {
		if (gameState.playing && !document.hidden && gameState.fps > 0) lowFps = Math.min(lowFps, gameState.fps);
	}, 1000);
	setInterval(() => {
		if (!gameState.playing) return;
		const now = { ...sceneInfo, t: performance.now() };
		const mins = (now.t - last.t) / 60000;
		const sync = syncStats();
		const heap = (performance as any).memory?.usedJSHeapSize;
		report(
			"health",
			[
				`fps ${gameState.fps}${lowFps !== Infinity ? ` (lowest ${lowFps})` : ""}`,
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
	}, 60_000);
}
