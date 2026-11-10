// On-screen controls for Mobile mode (asked 7 Nov 2026).
//
// A joystick (bottom left) and buttons J / D / DD / C (bottom right, L shape:
// J D DD on the bottom row, C above DD for claw grip), plus small Pause and
// Back buttons at the top. Each button presses the KEY your save file binds to
// that action (Celeste/Saves/settings.celeste), so it follows your controls.
//
// Joystick, picked in Settings:
//   fixed     sits where you put it ("Move joystick" in Settings, then drag it)
//   floating  appears wherever your left thumb first touches the left half
// Buttons size themselves from the screen, they are not movable.
import { store } from "./store";
import { gameState } from "./game/dotnet";
import { rootFolder } from "./fs";

type Action = "Left" | "Right" | "Up" | "Down" | "Jump" | "Dash" | "Grab" | "DemoDash" | "Pause" | "Cancel";

// Celeste's defaults, used when the save has no binding
const DEFAULTS: Record<Action, string> = {
	Left: "Left",
	Right: "Right",
	Up: "Up",
	Down: "Down",
	Jump: "C",
	Dash: "X",
	Grab: "Z",
	DemoDash: "LeftShift",
	Pause: "Enter",
	Cancel: "X",
};

// XNA key name (as written in settings.celeste) -> browser key event fields
function keyInfo(xna: string): { code: string; key: string; keyCode: number; location: number } | null {
	const named: Record<string, [string, string, number, number?]> = {
		Space: ["Space", " ", 32],
		Enter: ["Enter", "Enter", 13],
		Tab: ["Tab", "Tab", 9],
		Escape: ["Escape", "Escape", 27],
		Back: ["Backspace", "Backspace", 8],
		Delete: ["Delete", "Delete", 46],
		Insert: ["Insert", "Insert", 45],
		Home: ["Home", "Home", 36],
		End: ["End", "End", 35],
		PageUp: ["PageUp", "PageUp", 33],
		PageDown: ["PageDown", "PageDown", 34],
		Left: ["ArrowLeft", "ArrowLeft", 37],
		Up: ["ArrowUp", "ArrowUp", 38],
		Right: ["ArrowRight", "ArrowRight", 39],
		Down: ["ArrowDown", "ArrowDown", 40],
		LeftShift: ["ShiftLeft", "Shift", 16, 1],
		RightShift: ["ShiftRight", "Shift", 16, 2],
		LeftControl: ["ControlLeft", "Control", 17, 1],
		RightControl: ["ControlRight", "Control", 17, 2],
		LeftAlt: ["AltLeft", "Alt", 18, 1],
		RightAlt: ["AltRight", "Alt", 18, 2],
		OemQuestion: ["Slash", "/", 191],
		OemPeriod: ["Period", ".", 190],
		OemComma: ["Comma", ",", 188],
		OemSemicolon: ["Semicolon", ";", 186],
		OemQuotes: ["Quote", "'", 222],
		OemOpenBrackets: ["BracketLeft", "[", 219],
		OemCloseBrackets: ["BracketRight", "]", 221],
		OemPipe: ["Backslash", "\\", 220],
		OemBackslash: ["IntlBackslash", "\\", 226],
		OemMinus: ["Minus", "-", 189],
		OemPlus: ["Equal", "=", 187],
		OemTilde: ["Backquote", "`", 192],
	};
	if (named[xna]) {
		const [code, key, keyCode, location = 0] = named[xna];
		return { code, key, keyCode, location };
	}
	if (/^[A-Z]$/.test(xna)) return { code: "Key" + xna, key: xna.toLowerCase(), keyCode: xna.charCodeAt(0), location: 0 };
	let m = /^D(\d)$/.exec(xna);
	if (m) return { code: "Digit" + m[1], key: m[1], keyCode: 48 + +m[1], location: 0 };
	m = /^NumPad(\d)$/.exec(xna);
	if (m) return { code: "Numpad" + m[1], key: m[1], keyCode: 96 + +m[1], location: 3 };
	m = /^F(\d{1,2})$/.exec(xna);
	if (m) return { code: "F" + m[1], key: "F" + m[1], keyCode: 111 + +m[1], location: 0 };
	return null;
}

let bindings: Record<Action, string> = { ...DEFAULTS };

// reads the first keyboard key of each action from the save's settings
export async function loadBindings() {
	const next = { ...DEFAULTS };
	try {
		const celeste = await rootFolder.getDirectoryHandle("Celeste");
		const saves = await celeste.getDirectoryHandle("Saves");
		const file = await (await saves.getFileHandle("settings.celeste")).getFile();
		const xml = new DOMParser().parseFromString(await file.text(), "text/xml");
		for (const action of Object.keys(DEFAULTS) as Action[]) {
			const key = xml.querySelector(`Settings > ${action} > Keyboard > Keys`)?.textContent?.trim();
			if (key && keyInfo(key)) next[action] = key;
		}
	} catch (e) {
		console.warn("[touch] could not read your controls, using Celeste's defaults", e);
	}
	bindings = next;
	console.log("[touch] buttons press:", bindings);
}

let target: HTMLElement | null = null;
const held = new Map<Action, number>(); // action -> how many touches hold it

function send(action: Action, down: boolean, auto = false) {
	const info = keyInfo(bindings[action]);
	if (!info || !target) return;
	const ev = new KeyboardEvent(down ? "keydown" : "keyup", {
		code: info.code,
		key: info.key,
		location: info.location,
		bubbles: true,
		cancelable: true,
	});
	// older code reads keyCode/which, which a constructed event leaves at 0
	Object.defineProperty(ev, "keyCode", { get: () => info.keyCode });
	Object.defineProperty(ev, "which", { get: () => info.keyCode });
	// presses made by the page itself (auto-pause) are not the player coming back
	if (auto) Object.defineProperty(ev, "myCelesteAuto", { value: true });
	target.dispatchEvent(ev);
}

function press(action: Action) {
	const n = held.get(action) || 0;
	held.set(action, n + 1);
	if (n === 0) send(action, true);
}

function release(action: Action) {
	const n = held.get(action) || 0;
	if (n <= 1) {
		held.delete(action);
		if (n === 1) send(action, false);
	} else held.set(action, n - 1);
}

function releaseAll() {
	for (const a of [...held.keys()]) {
		held.set(a, 1);
		release(a);
	}
}

const CSS = `
.touch-ui { position: absolute; inset: 0; z-index: 2; pointer-events: none; touch-action: none;
	user-select: none; -webkit-user-select: none; font-family: var(--font-display, system-ui), sans-serif; }
.touch-ui.hidden { display: none; }
.touch-ui .zone { position: absolute; left: 0; top: 0; bottom: 0; width: 45%; pointer-events: auto; touch-action: none; }
.touch-ui .zone.off { pointer-events: none; }
.touch-ui .stick { position: absolute; width: 30vmin; height: 30vmin; margin: -15vmin 0 0 -15vmin;
	border-radius: 50%; background: rgba(255,255,255,0.12); border: 0.5vmin solid rgba(255,255,255,0.35);
	pointer-events: auto; touch-action: none; }
.touch-ui .stick.floating { pointer-events: none; opacity: 0.55; }
.touch-ui .stick.floating.active { opacity: 1; }
.touch-ui .stick.editing { border-color: #ffd54a; border-style: dashed; }
.touch-ui .knob { position: absolute; left: 50%; top: 50%; width: 13vmin; height: 13vmin; margin: -6.5vmin 0 0 -6.5vmin;
	border-radius: 50%; background: rgba(255,255,255,0.45); }
.touch-ui .btn { position: absolute; width: 15vmin; height: 15vmin; border-radius: 50%;
	background: rgba(255,255,255,0.18); border: 0.5vmin solid rgba(255,255,255,0.45); color: #fff;
	display: flex; align-items: center; justify-content: center; font-size: 5.5vmin; font-weight: 700;
	pointer-events: auto; touch-action: none; }
.touch-ui .btn.down { background: rgba(255,255,255,0.5); }
.touch-ui .btn.small { width: 10vmin; height: 7vmin; border-radius: 2vmin; font-size: 3.2vmin; }
.touch-ui .done { position: absolute; left: 50%; top: 40%; transform: translate(-50%, -50%); pointer-events: auto;
	background: #ffd54a; color: #000; border: 0; border-radius: 1em; padding: 0.6em 1.4em; font-size: 4vmin; }
`;

export function mountTouchControls(container: HTMLElement, canvas: HTMLCanvasElement) {
	target = canvas;
	const style = document.createElement("style");
	style.textContent = CSS;
	document.head.append(style);

	const ui = document.createElement("div");
	ui.className = "touch-ui hidden";
	const zone = document.createElement("div");
	zone.className = "zone off";
	const stick = document.createElement("div");
	stick.className = "stick";
	const knob = document.createElement("div");
	knob.className = "knob";
	stick.append(knob);
	const done = document.createElement("button");
	done.className = "done";
	done.textContent = "Done moving";
	done.style.display = "none";
	ui.append(zone, stick, done);

	// --- buttons ---
	const S = 15; // button size in vmin
	const G = 2.5; // gap
	const button = (label: string, action: Action, css: string, small = false) => {
		const b = document.createElement("div");
		b.className = "btn" + (small ? " small" : "");
		b.textContent = label;
		b.style.cssText = css;
		const ids = new Set<number>();
		b.addEventListener("pointerdown", (e) => {
			e.preventDefault();
			b.setPointerCapture(e.pointerId);
			ids.add(e.pointerId);
			b.classList.add("down");
			press(action);
		});
		const up = (e: PointerEvent) => {
			if (!ids.delete(e.pointerId)) return;
			if (ids.size === 0) b.classList.remove("down");
			release(action);
		};
		b.addEventListener("pointerup", up);
		b.addEventListener("pointercancel", up);
		ui.append(b);
	};
	const right = (n: number) => `right: calc(3vmin + ${n} * ${S + G}vmin)`;
	button("J", "Jump", `bottom: 4vmin; ${right(2)}`);
	button("D", "Dash", `bottom: 4vmin; ${right(1)}`);
	button("DD", "DemoDash", `bottom: 4vmin; ${right(0)}`);
	button("C", "Grab", `bottom: calc(4vmin + ${S + G}vmin); ${right(0)}`);
	button("II", "Pause", "top: 2vmin; right: 3vmin", true);
	button("Back", "Cancel", "top: 2vmin; right: 15vmin", true);

	// --- joystick ---
	const R = 15; // stick radius in vmin
	let stickId: number | null = null;
	let center = { x: 0, y: 0 };
	const dirs = new Set<Action>();
	const vmin = () => Math.min(window.innerWidth, window.innerHeight) / 100;

	const placeFixed = () => {
		stick.style.left = store.joyX * 100 + "%";
		stick.style.top = store.joyY * 100 + "%";
	};
	const setDirs = (want: Set<Action>) => {
		for (const d of [...dirs]) if (!want.has(d)) (dirs.delete(d), release(d));
		for (const d of want) if (!dirs.has(d)) (dirs.add(d), press(d));
	};
	const move = (x: number, y: number) => {
		const r = R * vmin();
		let dx = (x - center.x) / r;
		let dy = (y - center.y) / r;
		const len = Math.hypot(dx, dy);
		if (len > 1) ((dx /= len), (dy /= len));
		knob.style.transform = `translate(${dx * R * 0.6}vmin, ${dy * R * 0.6}vmin)`;
		// 8 directions: a diagonal counts once the stick leans enough both ways
		const want = new Set<Action>();
		if (len > 0.3) {
			if (dx > 0.38) want.add("Right");
			if (dx < -0.38) want.add("Left");
			if (dy > 0.38) want.add("Down");
			if (dy < -0.38) want.add("Up");
		}
		setDirs(want);
	};
	const endStick = () => {
		stickId = null;
		knob.style.transform = "";
		setDirs(new Set());
		stick.classList.remove("active");
		if (store.joystickMode === "floating") stick.style.visibility = "hidden";
	};

	let editing = false;
	const startStick = (e: PointerEvent, el: HTMLElement) => {
		if (stickId !== null) return;
		e.preventDefault();
		el.setPointerCapture(e.pointerId);
		stickId = e.pointerId;
		const box = container.getBoundingClientRect();
		if (store.joystickMode === "floating") {
			stick.style.left = e.clientX - box.left + "px";
			stick.style.top = e.clientY - box.top + "px";
			stick.style.visibility = "visible";
			stick.classList.add("active");
			center = { x: e.clientX, y: e.clientY };
		} else {
			const s = stick.getBoundingClientRect();
			center = { x: s.left + s.width / 2, y: s.top + s.height / 2 };
		}
		if (!editing) move(e.clientX, e.clientY);
	};
	const onMove = (e: PointerEvent) => {
		if (e.pointerId !== stickId) return;
		if (editing) {
			const box = container.getBoundingClientRect();
			store.joyX = Math.min(0.95, Math.max(0.05, (e.clientX - box.left) / box.width));
			store.joyY = Math.min(0.95, Math.max(0.05, (e.clientY - box.top) / box.height));
			placeFixed();
			return;
		}
		move(e.clientX, e.clientY);
	};
	const onEnd = (e: PointerEvent) => {
		if (e.pointerId === stickId) endStick();
	};
	for (const el of [stick, zone]) {
		el.addEventListener("pointerdown", (e) => startStick(e, el));
		el.addEventListener("pointermove", onMove);
		// Chrome's earliest movement signal: arrives before the frame-aligned
		// pointermove, so a direction change reaches the game sooner
		el.addEventListener("pointerrawupdate" as any, onMove as any);
		el.addEventListener("pointerup", onEnd);
		el.addEventListener("pointercancel", onEnd);
	}

	done.addEventListener("click", () => {
		editing = false;
		store.touchEdit = false;
	});

	// --- show / hide, follow the settings ---
	let lastKey = "";
	const refresh = () => {
		const on = store.controls === "mobile" && gameState.playing;
		const key = `${on}|${store.joystickMode}|${store.touchEdit}`;
		if (key === lastKey) return;
		lastKey = key;
		ui.classList.toggle("hidden", !on);
		if (!on) {
			endStick();
			releaseAll();
			return;
		}
		loadBindings(); // the controls may have changed in the game's settings
		const floating = store.joystickMode === "floating";
		editing = !floating && !!store.touchEdit;
		zone.classList.toggle("off", !floating);
		stick.classList.toggle("floating", floating);
		stick.classList.toggle("editing", editing);
		done.style.display = editing ? "" : "none";
		if (floating) stick.style.visibility = "hidden";
		else {
			stick.style.visibility = "visible";
			placeFixed();
		}
	};
	setInterval(refresh, 250);
	refresh();
	window.addEventListener("blur", releaseAll);
	document.addEventListener("visibilitychange", () => document.hidden && releaseAll());
	container.append(ui);
}

// a short press of the game's Pause key (used by auto-pause)
export function pressPause(canvas: HTMLCanvasElement) {
	if (!target) target = canvas;
	send("Pause", true, true);
	setTimeout(() => send("Pause", false, true), 120);
}
