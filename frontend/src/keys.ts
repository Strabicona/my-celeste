// Chrome shortcuts while playing (10 Nov 2026). His controls use Left Ctrl
// (Back) with W A S D, so Back + Down = Ctrl+S opened Chrome's "Save page as".
// While the game runs, Ctrl/Cmd shortcuts are kept from Chrome; the game still
// gets the keys. Chrome never lets a page stop Ctrl+W / Ctrl+T / Ctrl+N outside
// fullscreen; in fullscreen the keyboard is locked to the game, which stops
// those too.
import { gameState } from "./game/dotnet";

function typingInPage(e: KeyboardEvent) {
	const t = e.target as HTMLElement | null;
	return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

addEventListener(
	"keydown",
	(ev) => {
		const e = ev as KeyboardEvent;
		if (!gameState.playing || typingInPage(e)) return;
		if (e.ctrlKey || e.metaKey || e.altKey || /^F([1-9]|1[0-2])$/.test(e.key)) {
			// F11 (fullscreen) and F5 (reload) stay Chrome's
			if (e.key === "F11" || e.key === "F5") return;
			e.preventDefault();
		}
	},
	{ capture: true }
);

document.addEventListener("fullscreenchange", () => {
	const kb = (navigator as any).keyboard;
	if (!kb?.lock) return;
	if (document.fullscreenElement) kb.lock().catch(() => {});
	else kb.unlock?.();
});
