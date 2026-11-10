// Keeps the game's tab from being put to sleep by Chrome while it is hidden.
//
// Chrome freezes a hidden tab that uses a lot of CPU after ~5 min when it is
// silent. A frozen tab keeps the game files open but cannot answer another tab,
// which then cannot load ("A game file was busy"). A tab playing sound is never
// frozen, so while the game tab is hidden it plays a 20 Hz tone at -60 dB:
// loud enough for Chrome to count it as sound, far too quiet to hear.
// The auto-pause (away.ts) is untouched: the game stays paused where it was.
import { gameState } from "./game/dotnet";

const LEVEL = 0.001; // -60 dB
let ctx: AudioContext | null = null;
let gain: GainNode | null = null;

function setup() {
	if (ctx) return;
	try {
		const Ctx = window.AudioContext || (window as any).webkitAudioContext;
		ctx = new Ctx();
		const osc = ctx.createOscillator();
		osc.frequency.value = 20;
		gain = ctx.createGain();
		gain.gain.value = 0;
		osc.connect(gain).connect(ctx.destination);
		osc.start();
	} catch (e) {
		console.warn("[awake] could not set up the keep-awake tone:", e);
		ctx = null;
	}
	update();
}

function update() {
	if (!ctx || !gain) return;
	const on = gameState.playing && document.visibilityState === "hidden";
	gain.gain.value = on ? LEVEL : 0;
	if (on) {
		ctx.resume().catch(() => {});
		console.log("[awake] tab hidden: keep-awake tone on");
	} else {
		// nothing to play while visible: stop the sound player to save power
		ctx.suspend().catch(() => {});
	}
}

// a sound player may only start after a tap or key (browser rule), so it is
// made on the first one and kept for the life of the page
for (const type of ["pointerdown", "keydown"]) {
	addEventListener(type, setup, { capture: true, once: true });
}
document.addEventListener("visibilitychange", update);
useChange([gameState.playing], update);
