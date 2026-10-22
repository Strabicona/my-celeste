import { gameState, loglisteners, preInit } from "./dotnet";
import { Loader } from "./loading";

export const LogView: Component<{ scrolling: boolean }> = function () {
	this.css = `
		min-height: 0;
		flex: 1;
		font-family: var(--font-mono);

		.log {
			word-break: break-all;
		}

		::-webkit-scrollbar {
			width: 10px;
		}
		::-webkit-scrollbar-track {
			background: var(--surface3);
		}
		::-webkit-scrollbar-thumb {
			background: var(--surface6);
		}
	`;

	const create = (color: string, log: string) => {
		const el = document.createElement("div");
		el.classList.add("log");
		el.innerText = log;
		el.style.color = color;
		return el;
	};

	this.mount = () => {
		const logroot = this.root as HTMLElement;
		// Only the newest lines are kept, and the page only draws them while the
		// log panel is actually visible. Before, every line was kept forever and
		// re-measured 4 times a second, so the page got slower the longer you played.
		const MAX_LINES = 300;
		let pending: { color: string; log: string }[] = [];

		loglisteners.push((x) => {
			pending.push(x);
			if (pending.length > MAX_LINES)
				pending.splice(0, pending.length - MAX_LINES);
		});
		setInterval(() => {
			if (pending.length === 0) return;
			if (logroot.offsetParent === null || logroot.clientHeight === 0) return;
			const frag = document.createDocumentFragment();
			for (const x of pending) frag.append(create(x.color, x.log));
			pending = [];
			logroot.appendChild(frag);
			while (logroot.childElementCount > MAX_LINES)
				logroot.firstElementChild!.remove();
			logroot.scrollTop = logroot.scrollHeight;
		}, 250);
	};

	return (
		<div
			class="component-log"
			style={this.scrolling ? "overflow: auto" : "overflow: hidden"}
		/>
	);
};

export const GameView: Component<
	{ canvas: HTMLCanvasElement },
	{},
	{ start: () => Promise<void> }
> = function () {
	this.css = `
		aspect-ratio: 16 / 9;
		user-select: none;
		position: relative;

		transition: background 150ms, color 150ms;

		.gameoverlay, canvas {
			position: absolute;
			top: 0;
			left: 0;
			width: 100%;
			height: 100%;
			transition: background 150ms, color 150ms, border-color 150ms;
			border-bottom: 1.75px solid var(--surface2);
		}

		div.started, canvas.stopped {
			visibility: hidden;
			z-index: 0;
		}

		canvas {
			z-index: 1;
		}

		.gameoverlay.notrunning {
			background: var(--surface0);
			color: var(--surface5);
			transition: background 150ms, color 150ms, border-color 150ms;
			font-family: var(--font-display);
			font-size: 2rem;
			font-weight: 570;

			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;

			z-index: 1;
		}

		.gameoverlay.loader {
			opacity: 0;
			visibility: hidden;
			display: none;
			transition: opacity 0.5s ease;
			pointer-events: none;
			z-index: 3;
		}

		.gameoverlay.loader.active {
			opacity: 1;
			visibility: visible;
			display: flex;
			transition: opacity 0.5s ease;
			pointer-events: auto;
		}

		canvas:fullscreen {
			border: none;
			border-radius: 0;
			background: black;
		}

		#fps {
			position: absolute;
			top: 0.4em;
			right: 0.5em;
			z-index: 2;
			padding: 0.1em 0.45em;
			border-radius: 0.4em;
			background: rgba(0, 0, 0, 0.55);
			color: #fff;
			font-family: var(--font-mono);
			font-size: 0.85em;
			pointer-events: none;
		}
		#fps.hidden {
			display: none;
		}
	`;
	const notRunning = use(gameState.playing, (x) =>
		x ? "gameoverlay notrunning started" : "gameoverlay notrunning stopped"
	);
	const loader = use(gameState.initting, (x) =>
		x ? "gameoverlay loader active" : "gameoverlay loader"
	);
	const canvas = use(gameState.playing, (x) =>
		x ? "canvas started" : "canvas stopped"
	);

	this.start = async () => {
		await preInit();
	};

	return (
		<div>
			<div class={loader}>
				<Loader />
			</div>
			<div class={notRunning}>Game not running.</div>
			<div id="fps" class={use(gameState.fps, (x) => (x >= 0 ? "" : "hidden"))}>
				{use(gameState.fps, (x) => `${x} FPS`)}
			</div>
			<canvas
				id="canvas"
				class={canvas}
				bind:this={use(this.canvas)}
				on:contextmenu={(e: Event) => e.preventDefault()}
			/>
		</div>
	);
};

export { gameState, play, loadedLibcurlPromise } from "./dotnet";
