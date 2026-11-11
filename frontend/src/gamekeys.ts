// Your keyboard controls, read from the save (Celeste/Saves/settings.celeste),
// and a short press of the game's Pause key, used by auto-pause (away.ts).
// The on-screen mobile controls that used to live here were removed on
// 11 Nov 2026 (asked).
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
		console.warn("[keys] could not read your controls, using Celeste's defaults", e);
	}
	bindings = next;
	console.log("[keys] your controls:", bindings);
}


let target: HTMLElement | null = null;

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

// a short press of the game's Pause key (used by auto-pause)
export function pressPause(canvas: HTMLCanvasElement) {
	if (!target) target = canvas;
	send("Pause", true, true);
	setTimeout(() => send("Pause", false, true), 120);
}
