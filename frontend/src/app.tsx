// first: one tab at a time (see onetab.ts) — must finish before anything touches the game files
import "./onetab";
import "./report";
import "dreamland";
import "./styles.css";
import { Main } from "./main";
import { Splash } from "./splash";
import { store } from "./store";
import "./analytics";

const App: Component<
	{},
	{
		el: HTMLElement;
		showInstructions: boolean;
	}
> = function () {
	this.css = `
		position: relative;

		#splash, #main {
			position: absolute;
			width: 100%;
			height: 100%;
			top: 0;
			left: 0;
		}
		#splash {
			z-index: 100;
		}

		@keyframes fadeout {
			from { opacity: 1; scale: 1; }
			to { opacity: 0; scale: 1.2; }
		}
	`;

	const main = <Main />;
	const start = () => (main.$ as ComponentType<typeof Main>).start();
	const next = (anim: boolean) => {
		if (anim) {
			this.el.addEventListener("animationend", this.el.remove);
			this.el.style.animation = "fadeout 0.5s ease";
		} else {
			this.el.remove();
		}
		start();
	};

	return (
		<div id="app" class={use`${store.theme} ${store.accentColor}`}>
			<div id="splash" bind:this={use(this.el)}>
				<Splash on:next={next} start={start} />
			</div>
			<div id="main">{main}</div>
		</div>
	);
};

const root = document.getElementById("app")!;

// The game needs the browser's multithreading mode. On GitHub Pages a helper
// script switches it on, which takes one automatic reload the first time (and
// again after the site's data is cleared). Never start the game before that.
// tidy the address bar after a fresh reload (see index.html)
if (new URLSearchParams(location.search).has("fresh")) {
	const u = new URL(location.href);
	u.searchParams.delete("fresh");
	history.replaceState(null, "", u.toString());
}

// Some first opens (seen on Chrome for iPhone, 8 Nov 2026) are not ready after
// one reload; reopening worked. So try a few reloads by itself, waiting for
// the helper each time, and only then offer a Try again button.
const ISOLATION_TRIES = 3;

async function waitForIsolation(): Promise<boolean> {
	if (self.crossOriginIsolated) return true;
	const tries = Number(sessionStorage.getItem("my-celeste-isolation-reload") || "0");
	if (tries < ISOLATION_TRIES) {
		root.textContent = "Getting things ready, the page will reload by itself...";
		sessionStorage.setItem("my-celeste-isolation-reload", String(tries + 1));
		const sw = navigator.serviceWorker;
		await Promise.race([
			sw ? sw.ready.then(() => (sw.controller ? null : new Promise((r) => sw.addEventListener("controllerchange", r, { once: true })))) : null,
			new Promise((r) => setTimeout(r, 2500 + tries * 2500)),
		]);
		location.reload();
		return false;
	}
	root.textContent = "";
	const box = document.createElement("div");
	box.style.cssText =
		"display:flex;flex-direction:column;gap:1em;align-items:center;justify-content:center;height:100vh;text-align:center;padding:1em;font:16px system-ui,sans-serif;";
	const text = document.createElement("p");
	text.textContent = "The game could not start in this tab yet.";
	const again = document.createElement("button");
	again.textContent = "Try again";
	again.style.cssText = "font:inherit;padding:0.6em 1.4em;border-radius:0.6em;border:0;background:#8a5cf6;color:#fff;";
	again.addEventListener("click", () => {
		sessionStorage.removeItem("my-celeste-isolation-reload");
		// ask the browser to keep the game files instead of clearing them when
		// space is tight (iPhone browsers do clear them otherwise)
		navigator.storage?.persist?.().then((kept) => console.log("[files] kept permanently:", kept)).catch(() => {});
		location.reload();
	});
	const hint = document.createElement("p");
	hint.style.opacity = "0.7";
	hint.textContent = "If it keeps failing: not in incognito, not inside another app's browser.";
	box.append(text, again, hint);
	root.append(box);
	return false;
}

if (await waitForIsolation())
	try {
		sessionStorage.removeItem("my-celeste-isolation-reload");
		// ask the browser to keep the game files instead of clearing them when
		// space is tight (iPhone browsers do clear them otherwise)
		navigator.storage?.persist?.().then((kept) => console.log("[files] kept permanently:", kept)).catch(() => {});
		root.replaceWith(<App />);
	} catch (err) {
		console.log(err);
		root.replaceWith(document.createTextNode(`Failed to load:\n ${err}`));
		document.body.classList.add("error");
	}
