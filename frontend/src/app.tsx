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

async function waitForIsolation(): Promise<boolean> {
	if (self.crossOriginIsolated) return true;
	const tried = sessionStorage.getItem("my-celeste-isolation-reload");
	root.textContent = tried
		? "This browser window can't run the game: open the link in a normal Chrome window (not incognito, not Brave)."
		: "Getting things ready, the page will reload by itself...";
	if (!tried && navigator.serviceWorker) {
		sessionStorage.setItem("my-celeste-isolation-reload", "1");
		// reload once the helper is installed, or after 8 seconds at the latest
		await Promise.race([
			navigator.serviceWorker.ready,
			new Promise((r) => setTimeout(r, 8000)),
		]);
		location.reload();
	}
	return false;
}

if (await waitForIsolation())
	try {
		sessionStorage.removeItem("my-celeste-isolation-reload");
		root.replaceWith(<App />);
	} catch (err) {
		console.log(err);
		root.replaceWith(document.createTextNode(`Failed to load:\n ${err}`));
		document.body.classList.add("error");
	}
