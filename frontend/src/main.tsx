import { gameState, play, GameView, LogView } from "./game/index";
import { Dialog } from "./ui/Dialog";
import { Button, Icon } from "./ui/Button";
import { store } from "./store";

import { OpfsExplorer } from "./fs";
import { Achievements } from "./achievements";
import { cloudState } from "./cloud";
import { importSaveFiles, nudgeSaveSync, syncNow } from "./savesync";
import { gameEvents } from "./game/dotnet";
import { setupRelaunch } from "./relaunch";
import { Settings } from "./settings";

import iconPlayArrow from "@ktibow/iconset-material-symbols/play-arrow";
import iconFullscreen from "@ktibow/iconset-material-symbols/fullscreen";
import iconFolderOpen from "@ktibow/iconset-material-symbols/folder-open";
import iconTrophy from "@ktibow/iconset-material-symbols/trophy";
import iconCloudDone from "@ktibow/iconset-material-symbols/cloud-done";
import iconUpload from "@ktibow/iconset-material-symbols/upload";
import iconCloudOff from "@ktibow/iconset-material-symbols/cloud-off";
import iconMenu from "@ktibow/iconset-material-symbols/menu";
import iconClose from "@ktibow/iconset-material-symbols/close";
import { linkFor, profile, PROFILES, ProfileId } from "./profile";
import { startAwayWatch } from "./away";
import "./keys";
import "./keepawake";
import { report, BUILD } from "./report";
import { gameFileLooksWhole } from "./fs";
import { removeLocalGame } from "./cloudgame";

export const NAME = "webleste";

function alertImport(done: string[]) {
	console.log(
		done.length
			? `[saves] imported ${done.join(", ")}`
			: "[saves] nothing imported: pick files like 0.celeste or settings.celeste"
	);
}


// Before starting: make sure the main game file is whole on this device. If it
// is not, forget this device's copy and reload, so the next load fetches it
// fresh instead of the game failing with "error init()".
async function startGame() {
	// fingerprint of the main game file, compared with a known good copy when
	// something fails on a device (good: 5,239,808 bytes, sha256 e6e41f6e...)
	try {
		const root = await navigator.storage.getDirectory();
		const f = await (await root.getFileHandle("CustomCeleste.dll")).getFile();
		const sum = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await f.arrayBuffer()))]
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		report("play-start", `CustomCeleste.dll ${f.size} bytes sha256 ${sum}`);
	} catch (e) {
		report("play-start", "could not fingerprint CustomCeleste.dll: " + e);
	}
	const check = await gameFileLooksWhole();
	if (!check.ok) {
		report("play check", check.why);
		await removeLocalGame();
		alert("A game file was damaged on this device. The page will reload and fetch it again (your save is online).");
		location.reload();
		return;
	}
	await blockBrokenMods();
	play();
}

// Mods that are in the packs but must not run here. Everest skips any mod
// listed in Mods/blacklist.txt. Speedrun Tool (added 11 Nov 2026 for save
// states) crashes the whole game in the browser when it saves a state (F7),
// so it stays off until that is fixed.
const BLOCKED_MODS = ["SpeedrunTool.zip"];
async function blockBrokenMods() {
	try {
		const root = await navigator.storage.getDirectory();
		const celeste = await root.getDirectoryHandle("Celeste");
		const mods = await celeste.getDirectoryHandle("Mods", { create: false });
		const f = await mods.getFileHandle("blacklist.txt", { create: true });
		const w = await f.createWritable();
		await w.write(
			"# written by my-celeste: these mods crash the game in the browser\n" + BLOCKED_MODS.join("\n") + "\n"
		);
		await w.close();
	} catch {
		// no Mods folder (Plain Celeste): nothing to block
	}
}

// Mod switch with the game open: save, stop, reopen the other mod and start it.
async function switchModsTo(to: ProfileId) {
	if (profile?.id === to) return;
	switching.textContent = `Switching to ${PROFILES[to].label}${PROFILES[to].noSound ? " (no sound)" : ""}... saving first`;
	switching.style.display = "flex";
	try {
		await syncNow();
	} catch {}
	const url = new URL(linkFor(to));
	url.searchParams.set("autoplay", "1");
	location.assign(url.toString());
}
const switching = document.createElement("div");
switching.style.cssText =
	"position:fixed;inset:0;z-index:100;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,0.75);color:#fff;font:600 1.3rem system-ui,sans-serif;";
document.body.append(switching);

// The phone closed the tab while the game was running (no clean exit), e.g. to
// get memory back: report it on the next load, so it shows in the error log.
{
	const KEY = "my-celeste-playing";
	const was = sessionStorage.getItem(KEY);
	if (was) {
		const secs = Math.round((Date.now() - Number(was)) / 1000);
		report("tab reloaded while playing", `the game had been running about ${secs}s when the tab was closed or crashed`);
		sessionStorage.removeItem(KEY);
	}
	useChange([gameState.playing], () => {
		if (gameState.playing) sessionStorage.setItem(KEY, String(Date.now()));
	});
	addEventListener("pagehide", () => sessionStorage.removeItem(KEY));
}

// the game says when it has written its saves: send them then
gameEvents.onSaved = nudgeSaveSync;

// after 8 hours of the game open: save & quit, then a Relaunch button
setupRelaunch(startGame);

// opened by a mod switch: press Play by itself once the game is ready
if (new URLSearchParams(location.search).has("autoplay")) {
	const u = new URL(location.href);
	u.searchParams.delete("autoplay");
	history.replaceState(null, "", u.toString());
	let done = false;
	useChange([gameState.ready], () => {
		if (done || !gameState.ready || gameState.playing) return;
		done = true;
		startGame();
	});
}

// A page that starts the game without a tap may get its sound held back by the
// browser: the first tap or key lets every sound player of the page play.
const audioContexts: AudioContext[] = [];
for (const name of ["AudioContext", "webkitAudioContext"]) {
	const Base = (window as any)[name];
	if (!Base) continue;
	(window as any)[name] = class extends Base {
		constructor(...args: any[]) {
			super(...args);
			audioContexts.push(this as unknown as AudioContext);
		}
	};
}
const resumeAudio = () => {
	for (const c of audioContexts) if (c.state === "suspended") c.resume().catch(() => {});
};
addEventListener("pointerdown", resumeAudio, { capture: true });
addEventListener("keydown", resumeAudio, { capture: true });

export const Logo: Component<{}, {}> = function () {
	this.css = `
		display: flex;
		align-items: center;
		font-size: 1.5rem;

		font-family: var(--font-display);
		color: var(--fg);

		&:hover {
		  color: var(--accent);
		}

		img {
			image-rendering: pixelated;
			-ms-interpolation-mode: nearest-neighbor;
			width: 3rem;
			height: 3rem;
		}

		.extras {
			align-self: start;
			padding: 0.25rem 0;
			font-size: 1rem;
			color: var(--fg6);

			display: flex;
			flex-direction: column;
			justify-content: space-between;
		}
	`;
	return (
		<a href="https://github.com/MercuryWorkshop/celeste-wasm" target="_blank">
			<img alt="Celeste icon" src="./app.webp" />
			<span>{NAME}</span>
			<div class="extras">
				<span class="ver">v1.4.0.0 · {BUILD}</span>
			</div>
		</a>
	);
};

// The menu (8 Nov 2026): a sidebar pulled from the left edge (tap the tab or
// swipe from the edge), so the game gets the whole screen. Play and the save
// status stay outside it, next to the tab.
const TopBar: Component<
	{
		canvas: HTMLCanvasElement;
		fsOpen: boolean;
		showLog: number;
		steamOpen: boolean;
		achievementsOpen: boolean;
		modInstallerOpen: boolean;
		settingsOpen: boolean;
	},
	{
		allowPlay: boolean;
		driveLabel: string;
		importInput: HTMLInputElement;
		open: boolean;
	}
> = function () {
	this.css = `
		position: fixed;
		inset: 0;
		z-index: 50;
		pointer-events: none;

		.cluster {
			position: absolute;
			top: 0.5rem;
			left: 0.5rem;
			display: flex;
			gap: 0.4rem;
			pointer-events: auto;
			opacity: 0.85;
		}
		.cluster .playbtn.hidden { display: none; }
		.cluster button {
			min-width: 2.75rem;
			height: 2.75rem;
			padding-inline: 0.7rem;
		}
		.cluster button svg {
			width: 1.6rem;
			height: 1.6rem;
		}

		.edge {
			position: absolute;
			left: 0;
			top: 0;
			bottom: 0;
			width: 14px;
			pointer-events: auto;
			touch-action: none;
		}

		.backdrop {
			position: absolute;
			inset: 0;
			background: rgba(0, 0, 0, 0.45);
			opacity: 0;
			transition: opacity 0.2s;
		}
		.backdrop.open {
			opacity: 1;
			pointer-events: auto;
		}

		.drawer {
			position: absolute;
			top: 0;
			left: 0;
			bottom: 0;
			width: min(21rem, 88vw);
			background: var(--bg);
			color: var(--fg);
			border-right: 1.75px solid var(--surface2);
			transform: translateX(-105%);
			transition: transform 0.22s ease;
			pointer-events: auto;
			overflow-y: auto;
			padding: 0.8rem 0.9rem 2rem;
			display: flex;
			flex-direction: column;
			gap: 1.1rem;
		}
		.drawer.open { transform: none; }

		.head {
			display: flex;
			align-items: center;
			justify-content: space-between;
		}

		section {
			display: flex;
			flex-direction: column;
			gap: 0.5rem;
		}
		h3 {
			margin: 0;
			font-family: var(--font-display);
			font-size: 0.95rem;
			text-transform: uppercase;
			letter-spacing: 0.06em;
			color: var(--fg6);
		}
		.row {
			display: flex;
			gap: 0.5rem;
		}
		.row > * { flex: 1; }
		.status {
			font-size: 0.9rem;
			opacity: 0.8;
		}
	`;

	this.open = false;

	useChange([gameState.ready, gameState.playing], () => {
		this.allowPlay = gameState.ready && !gameState.playing;
	});

	useChange(
		[cloudState.syncing, cloudState.waiting, cloudState.lastSaved, cloudState.error],
		() => {
			this.driveLabel = cloudState.syncing
				? "Saving online..."
				: cloudState.error
					? "Save error, tap to retry"
					: cloudState.waiting > 0
						? `${cloudState.waiting} save waiting`
						: cloudState.lastSaved === "loaded"
							? "Save loaded"
							: cloudState.lastSaved
								? `Saved ${cloudState.lastSaved}`
								: "Online save";
		}
	);

	const close = () => (this.open = false);

	const switchMods = (to: ProfileId) => {
		close();
		switchModsTo(to);
	};

	const fullscreen = async () => {
		close();
		try {
			await this.canvas.requestFullscreen({ navigationUI: "hide" });
		} catch {}
	};

	// swipe right from the left edge opens the menu
	let swipeX: number | null = null;

	const pick = (on: boolean) => (on ? "primary" : "normal") as "primary" | "normal";

	return (
		<div>
			<input
				type="file"
				multiple
				accept=".celeste"
				style="display: none"
				bind:this={use(this.importInput)}
				on:change={async () => {
					const files = [...(this.importInput.files || [])];
					this.importInput.value = "";
					if (!files.length) return;
					const done = await importSaveFiles(files);
					alertImport(done);
				}}
			/>
			<div
				class="edge"
				on:pointerdown={(e: PointerEvent) => {
					swipeX = e.clientX;
					(e.target as HTMLElement).setPointerCapture(e.pointerId);
				}}
				on:pointermove={(e: PointerEvent) => {
					if (swipeX !== null && e.clientX - swipeX > 30) {
						swipeX = null;
						this.open = true;
					}
				}}
				on:pointerup={() => (swipeX = null)}
				on:pointercancel={() => (swipeX = null)}
			/>
			<div class="cluster">
				<Button
					on:click={() => (this.open = true)}
					icon="full"
					type="normal"
					disabled={false}
					title="Menu"
				>
					<Icon icon={iconMenu} />
				</Button>
				<div class={use(gameState.playing, (p) => (p ? "playbtn hidden" : "playbtn"))}>
					<Button
						on:click={() => startGame()}
						icon="left"
						type="primary"
						disabled={use(this.allowPlay, (x) => !x)}
						title="Start Game"
					>
						<Icon icon={iconPlayArrow} />
						<span>Play</span>
					</Button>
				</div>
				<Button
					on:click={async () => {
						await syncNow();
					}}
					icon="full"
					type="normal"
					disabled={false}
					title={use(this.driveLabel)}
				>
					{$if(use(cloudState.error), <Icon icon={iconCloudOff} />, <Icon icon={iconCloudDone} />)}
				</Button>
			</div>
			<div class={use(this.open, (o) => (o ? "backdrop open" : "backdrop"))} on:click={close} />
			<nav class={use(this.open, (o) => (o ? "drawer open" : "drawer"))}>
				<div class="head">
					<Logo />
					<Button on:click={close} icon="full" type="normal" disabled={false} title="Close">
						<Icon icon={iconClose} />
					</Button>
				</div>

				<section>
					<h3>Play</h3>
					<div class="row">
						<Button
							on:click={() => {
								close();
								startGame();
							}}
							icon="left"
							type="primary"
							disabled={use(this.allowPlay, (x) => !x)}
							title="Start Game"
						>
							<Icon icon={iconPlayArrow} />
							<span>Play</span>
						</Button>
						<Button
							on:click={fullscreen}
							icon="left"
							type="normal"
							disabled={use(gameState.playing, (x) => !x)}
							title="Fullscreen"
						>
							<Icon icon={iconFullscreen} />
							<span>Fullscreen</span>
						</Button>
					</div>
				</section>

				<section>
					<h3>Mods</h3>
					<div class="row">
						<Button on:click={() => switchMods("sj")} icon="none" type={pick(profile?.id === "sj")} disabled={false} title="Strawberry Jam (own save)">
							{PROFILES.sj.label}
						</Button>
						<Button on:click={() => switchMods("ds")} icon="none" type={pick(profile?.id === "ds")} disabled={false} title="D-Sides (own save)">
							{PROFILES.ds.label}
						</Button>
					</div>
					<div class="status">No sound (lighter; same saves)</div>
					<div class="row">
						<Button on:click={() => switchMods("sjq")} icon="none" type={pick(profile?.id === "sjq")} disabled={false} title="Strawberry Jam without music and sound">
							{PROFILES.sjq.label}
						</Button>
						<Button on:click={() => switchMods("dsq")} icon="none" type={pick(profile?.id === "dsq")} disabled={false} title="D-Sides without music and sound">
							{PROFILES.dsq.label}
						</Button>
					</div>
					<div class="status">Plain Celeste (no Everest, no mods, your original save)</div>
					<div class="row">
						<Button on:click={() => switchMods("plain")} icon="none" type={pick(profile?.id === "plain")} disabled={false} title="Plain Celeste">
							{PROFILES.plain.label}
						</Button>
					</div>
				</section>

				<section>
					<h3>Save</h3>
					<div class="status">{use(this.driveLabel)}</div>
					<div class="row">
						<Button on:click={async () => await syncNow()} icon="left" type="normal" disabled={false} title="Save online now">
							<Icon icon={iconCloudDone} />
							<span>Save now</span>
						</Button>
						<Button
							on:click={() => this.importInput.click()}
							icon="left"
							type="normal"
							disabled={use(gameState.playing)}
							title="Import save files (0.celeste, settings.celeste) from this device. Do it before pressing Play."
						>
							<Icon icon={iconUpload} />
							<span>Import save</span>
						</Button>
					</div>
				</section>

				<section>
					<h3>Settings</h3>
					<Settings />
				</section>

				<section>
					<h3>Extras</h3>
					<div class="row">
						<Button
							on:click={() => {
								close();
								this.achievementsOpen = true;
							}}
							icon="left"
							type="normal"
							disabled={false}
							title="Achievements"
						>
							<Icon icon={iconTrophy} />
							<span>Achievements</span>
						</Button>
						<Button
							on:click={() => {
								close();
								this.fsOpen = true;
							}}
							icon="left"
							type="normal"
							disabled={false}
							title="File Browser"
						>
							<Icon icon={iconFolderOpen} />
							<span>Files</span>
						</Button>
					</div>
				</section>
			</nav>
		</div>
	);
};

export const Main: Component<
	{},
	{
		canvas: HTMLCanvasElement;
		fsOpen: boolean;
		achievementsOpen: boolean;
		modInstallerOpen: boolean;
		steamOpen: boolean;
		settingsOpen: boolean;
		logcontainer: HTMLDivElement;

		dialogs?: HTMLDivElement;

		logsize: number;
	},
	{
		start: () => Promise<void>;
	}
> = function () {
	this.css = `
		width: 100%;
		height: 100%;
		background: var(--bg-sub);
		color: var(--fg);

		display: flex;
		flex-direction: column;
		align-items: center;

		transition: background 150ms, color 150ms;

		.game {
			aspect-ratio: 16 / 9;
			flex: 0 1 min(calc(9 * 100vw / 16), 100vh);
		}

		.logs {
			display: flex;
			flex-direction: column;

			width: 100%;
			padding: 0 0.5em 0.5em 0.5em;

			background: var(--bg-sub);
		}

		.resizer {
			background: var(--surface1);
			cursor: ns-resize;
			width: 100%;
			flex: 0 0 0.25em;
		}

		.main h2 {
			margin: 0;
		}

		.expand { flex: 1; }
	`;

	this.fsOpen = false;
	this.achievementsOpen = false;

	this.mount = () => {
		startAwayWatch(this.canvas);
		useChange([store.logs], (x) => {
			this.logcontainer.style.height = `${x}px`;
			this.logsize = x;
		});
	};

	const game = <GameView bind:canvas={use(this.canvas)} />;

	let started = false;
	this.start = async () => {
		if (started) return;
		started = true;
		this.dialogs = (
			<div>
				<Dialog name="File System" bind:open={use(this.fsOpen)}>
					<OpfsExplorer open={use(this.fsOpen)} />
				</Dialog>
				<Dialog name="Achievements" bind:open={use(this.achievementsOpen)}>
					<Achievements open={use(this.achievementsOpen)} />
				</Dialog>
			</div>
		) as HTMLDivElement;
		await (game.$ as ComponentType<typeof GameView>).start();
	};

	this.logsize = 0;

	return (
		<div style={use`--logsize: ${use(this.logsize, (x) => x || 0)}px;`}>
			<TopBar
				canvas={use(this.canvas)}
				bind:fsOpen={use(this.fsOpen)}
				bind:achievementsOpen={use(this.achievementsOpen)}
				bind:steamOpen={use(this.steamOpen)}
				bind:modInstallerOpen={use(this.modInstallerOpen)}
				bind:settingsOpen={use(this.settingsOpen)}
				bind:showLog={use(store.logs)}
			/>
			<div class="game">{game}</div>
			<div class="expand" />
			{$if(
				use(store.logs, (x) => x > 0) /* @ts-expect-error */,
				<>
					<div
						class="resizer"
						on:mousedown={(e: MouseEvent) => {
							const startY = e.clientY;
							const startHeight = this.logcontainer.clientHeight;
							let height: number;
							const onMouseMove = (e: MouseEvent) => {
								height = startHeight + startY - e.clientY;
								this.logcontainer.style.height = `${height}px`;
								this.logsize = height;
							};
							const onMouseUp = () => {
								document.removeEventListener("mousemove", onMouseMove);
								document.removeEventListener("mouseup", onMouseUp);
								store.logs = height;
								this.logsize = height;
							};
							document.addEventListener("mousemove", onMouseMove);
							document.addEventListener("mouseup", onMouseUp);
						}}
					></div>
					<div class="logs" bind:this={use(this.logcontainer)}>
						<LogView scrolling={true} />
					</div>
				</>
			)}
			{use(this.dialogs)}
		</div>
	);
};
