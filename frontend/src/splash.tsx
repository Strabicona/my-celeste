import { Logo, NAME } from "./main";
import { Button, Icon } from "./ui/Button";
import {
	copyFile,
	copyFileForBadBrowsers,
	copyFolder,
	copyFolderForBadBrowsers,
	countFolder,
	countFolderForBadBrowsers,
	extractTar,
	hasContent,
	readAllEntries,
	FSAPI_UNAVAILABLE,
	PICKERS_UNAVAILABLE,
	rootFolder,
	rememberGameFileSize,
} from "./fs";
import {
	DownloadApp,
	gameState,
	PatchCeleste,
	pickDownloadsFolder,
} from "./game/dotnet";
import { SteamLogin, steamState } from "./steam";
import { gameInfo, hasAccess, LockedError, unlock } from "./cloud";
import {
	downloadPack,
	keepEverest,
	localPack,
	packInfo,
	packKey,
	removeLocalEverest,
	removeLocalMods,
	setLocalPack,
	uploadPack,
} from "./cloudpacks";
import { linkFor, profile, PROFILES } from "./profile";
import { report } from "./report";
import { downloadGame, gameKey, localGameVersion, removeLocalGame, uploadGame } from "./cloudgame";
import {
	copySavesFromDroppedFolder,
	copySavesFromFolder,
	hasCloudSaves,
	pullSaves,
	startSaveSync,
	syncNow,
} from "./savesync";
import { LogView } from "./game";

import iconFolderOpen from "@ktibow/iconset-material-symbols/folder-open-outline";
import iconCloudUpload from "@ktibow/iconset-material-symbols/cloud-upload";
//import iconDownload from "@ktibow/iconset-material-symbols/download";
import iconEncrypted from "@ktibow/iconset-material-symbols/encrypted";
import iconArchive from "@ktibow/iconset-material-symbols/archive";
import iconFolderZip from "@ktibow/iconset-material-symbols/folder-zip";
import iconManufacturing from "@ktibow/iconset-material-symbols/manufacturing";
import iconSettings from "@ktibow/iconset-material-symbols/settings";
import { Settings } from "./settings";
import { Dialog } from "./ui/Dialog";
import { event } from "./analytics";

const validateDirectory = async (directory: FileSystemDirectoryHandle) => {
	let content;
	try {
		content = await directory.getDirectoryHandle("Content", { create: false });
	} catch {
		return `Failed to find Content directory in selected folder`;
	}

	for (const child of [
		"Dialog",
		"Effects",
		"FMOD",
		"Graphics",
		"Maps",
		"Monocle",
		"Overworld",
		"Tutorials",
	]) {
		try {
			await content.getDirectoryHandle(child, { create: false });
		} catch {
			return `Failed to find subdirectory Content/${child}`;
		}
	}

	try {
		await directory.getFileHandle("Celeste.exe", { create: false });
	} catch {
		try {
			const orig = await directory.getDirectoryHandle("orig", {
				create: false,
			});
			await orig.getFileHandle("Celeste.exe", { create: false });
		} catch {
			return `Failed to find Celeste.exe in selected folder`;
		}
	}

	return "";
};

const validateDirectoryForBadBrowsers = async (
	entry: FileSystemEntry | null
) => {
	if (!entry || !entry.isDirectory) {
		return "what?";
	}
	let directory = entry as FileSystemDirectoryEntry;
	let reader = directory.createReader();
	let entries: FileSystemEntry[] = [];
	return new Promise<string>((resolve) => {
		reader.readEntries((result: FileSystemEntry[]) => {
			entries = result;
			let content = entries.find((e) => e.name === "Content");
			if (!content || !content.isDirectory) {
				resolve("Failed to find Content directory in selected folder");
				return;
			}
			let contentDir = content as FileSystemDirectoryEntry;
			let contentReader = contentDir.createReader();
			contentReader.readEntries((contentEntries: FileSystemEntry[]) => {
				for (const child of [
					"Dialog",
					"Effects",
					"FMOD",
					"Graphics",
					"Maps",
					"Monocle",
					"Overworld",
					"Tutorials",
				]) {
					if (!contentEntries.some((e) => e.name === child && e.isDirectory)) {
						resolve(`Failed to find subdirectory Content/${child}`);
						return;
					}
				}
			});
			resolve("");
		});
	});
};

const initialHasContent = await hasContent();
let initialIsPatched = false;
try {
	await rootFolder.getFileHandle("CustomCeleste.dll", { create: false });
	initialIsPatched = true;
} catch {}

// first-time setup state, decided by CloudIntro
let copyPcSaves = false;

// Patches Everest into this browser's game (once per game copy) and sends the
// result online. If only the sending failed last time, the patched files are
// still here and just the sending is tried again.
async function setupEverest(
	game: string,
	status: (s: string) => void,
	progress: (f: number) => void
) {
	const LOCAL = "local:" + game;
	if ((await localPack("everest")) !== LOCAL) {
		progress(-1);
		status("Installing Everest (one time, a few minutes)...");
		const zip = await packInfo("everestzip");
		if (zip) {
			try {
				await rootFolder.removeEntry("everest.zip");
			} catch {}
			await downloadPack("everestzip", zip, () => {});
		}
		try {
			await PatchCeleste(true);
		} catch (e) {
			// keep the game playable without mods rather than stuck
			await removeLocalEverest();
			throw e;
		}
		await setLocalPack("everest", LOCAL);
		await rememberGameFileSize(
			(await (await rootFolder.getFileHandle("CustomCeleste.dll")).getFile()).size
		);
		// let the engine finish writing the patched files before reading them
		await new Promise((r) => setTimeout(r, 3000));
	}
	status("Sending Everest online (one time)...");
	progress(0);
	const made = await uploadPack("everest", keepEverest, { game }, progress);
	await setLocalPack("everest", packKey(made));
}

const CloudIntro: Component<
	{
		"on:next": (type: "copy" | "done" | "done-animated") => void;
		start: () => Promise<void>;
	},
	{
		busy: boolean;
		status: string;
		percent: number;
		showProgress: boolean;
		needsSetup: boolean;
		locked: boolean;
		password: string;
	}
> = function () {
	this.css = `
		p { margin-block: 0.3em; }
	`;
	this.locked = !hasAccess();
	this.password = "";
	this.busy = true;
	this.status = "";
	this.percent = 0;
	this.showProgress = false;
	this.needsSetup = false;

	// fresh = ignore this browser's copy of the game and download it again
	const run = async (attempt = 1, fresh = false): Promise<void> => {
		this.busy = true;
		this.status = "Loading your save...";
		try {
			const hadSaves = await hasCloudSaves();
			await pullSaves();

			const game = await gameInfo();
			if (game) {
				const local = fresh ? null : await localGameVersion();
				// plain Celeste needs the game file without Everest: a device that
				// has Everest in it fetches the plain game again
				const plain = profile!.pack === null;
				const hasEverest = (await localPack("everest")) !== null;
				// only reuse this browser's files if they match the online copy
				if (!(initialHasContent && initialIsPatched && local === gameKey(game)) || (plain && hasEverest)) {
					// this browser has no game yet, or an older copy: fetch the current one
					await removeLocalGame();
					this.status = "Downloading the game...";
					this.showProgress = true;
					await downloadGame(game, (f) => (this.percent = f * 100));
				}

				if (plain) {
					await removeLocalMods();
					this.status = "Starting the engine...";
					await this.start();
					startSaveSync();
					this["on:next"]("done-animated");
					return;
				}

				// Everest, already patched into this game copy (made once, see below)
				const ev = await packInfo("everest");
				const evReady = !!ev && ev.game === gameKey(game);
				if (evReady && (await localPack("everest")) !== packKey(ev!)) {
					this.status = "Downloading Everest...";
					this.showProgress = true;
					await downloadPack("everest", ev!, (f) => (this.percent = f * 100));
					await setLocalPack("everest", packKey(ev!));
				}

				// this link's mods
				const mods = await packInfo(profile!.pack!);
				// "|w2": unpacked with the fixed writer (8 Nov 2026). iPhones/iPads that
				// unpacked mods before that fix have padded, damaged zips: they fetch the
				// mods again once. Other devices' older copies were always fine.
				const noSound = profile!.noSound && !!mods?.soundFrom;
				const baseMods = mods ? profile!.pack + ":" + packKey(mods) + (noSound ? ":nosound" : "") : null;
				const wantMods = baseMods ? baseMods + "|w2" : null;
				const haveMods = await localPack("mods");
				const iOS =
					/iPhone|iPad|iPod/.test(navigator.userAgent) ||
					(/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
				const modsOk = haveMods === wantMods || (!iOS && !!baseMods && haveMods === baseMods);
				if (!modsOk) {
					await removeLocalMods();
					if (mods) {
						this.status = `Downloading ${profile!.label}${noSound ? " (no sound)" : ""}...`;
						this.showProgress = true;
						await downloadPack(
							profile!.pack!,
							mods,
							(f) => (this.percent = f * 100),
							noSound ? mods.soundFrom : undefined
						);
						await setLocalPack("mods", wantMods);
					}
				}

				this.status = "Starting the engine...";
				await this.start();

				if (!evReady) {
					// one time only: patch Everest into the game here, then put the
					// result online so every other browser just downloads it. Kept
					// apart from the rest: a problem here never re-downloads the game.
					try {
						await setupEverest(gameKey(game), (s) => (this.status = s), (f) => {
							this.showProgress = f >= 0;
							if (f >= 0) this.percent = f * 100;
						});
					} catch (e) {
						console.error("[everest] one-time setup failed, will try again next time:", e);
					}
				}

				startSaveSync();
				this["on:next"]("done-animated");
				return;
			}

			copyPcSaves = !hadSaves;
			this.needsSetup = true;
			this.status = "";
			this.busy = false;
		} catch (e) {
			this.busy = false;
			console.error(e);
			if (!(e instanceof LockedError)) report(`load (${this.status})`, e);
			if (e instanceof LockedError) {
				this.locked = true;
				this.status = "Enter the password again.";
				return;
			}
			// Chrome briefly refuses a browser-storage file that changed while it
			// was being read (another tab, or a save finishing): wait, try again
			if ((e as DOMException)?.name === "InvalidStateError" && attempt < 4) {
				this.status = "A game file was busy, trying again...";
				await new Promise((r) => setTimeout(r, 1500 * attempt));
				return run(attempt + 1, fresh);
			}
			// still busy after the retries: stop using this browser's copy and
			// download the game again (the save is online, so nothing is lost)
			if ((e as DOMException)?.name === "InvalidStateError" && !fresh) {
				this.status = "Getting a fresh copy of the game...";
				return run(1, true);
			}
			// a file came out broken while being saved on this device: fetch the
			// game again once, from scratch
			if ((e as Error)?.name === "BrokenFileError" && !fresh) {
				this.status = "A game file came out broken on this device, fetching it again...";
				return run(1, true);
			}
			this.status = "Something went wrong: " + e;
		}
	};
	if (!this.locked && profile) queueMicrotask(() => run());

	const tryUnlock = async () => {
		this.busy = true;
		this.status = "Checking...";
		try {
			if (await unlock(this.password)) {
				this.password = "";
				this.locked = false;
				this.status = "";
				if (profile) run();
				else this.busy = false;
			} else {
				this.status = "Wrong password.";
				this.busy = false;
			}
		} catch (e) {
			this.status = "Could not reach the storage: " + e;
			this.busy = false;
		}
	};

	return (
		<div class="step">
			{$if(
				use(this.locked, (l) => !l && !profile),
				<div class="step">
					<p>Pick what to play. Each link keeps its own save.</p>
					<Button type="primary" icon="left" disabled={false} on:click={() => location.assign(linkFor("sj"))}>
						<Icon icon={iconFolderZip} />
						{PROFILES.sj.label}
					</Button>
					<Button type="primary" icon="left" disabled={false} on:click={() => location.assign(linkFor("ds"))}>
						<Icon icon={iconFolderZip} />
						{PROFILES.ds.label}
					</Button>
					<p>No sound (lighter, for phones):</p>
					<Button type="normal" icon="left" disabled={false} on:click={() => location.assign(linkFor("sjq"))}>
						<Icon icon={iconFolderZip} />
						{PROFILES.sjq.label}
					</Button>
					<Button type="normal" icon="left" disabled={false} on:click={() => location.assign(linkFor("dsq"))}>
						<Icon icon={iconFolderZip} />
						{PROFILES.dsq.label}
					</Button>
					<Button type="normal" icon="left" disabled={false} on:click={() => location.assign(linkFor("plain"))}>
						<Icon icon={iconFolderZip} />
						Plain Celeste (no mods)
					</Button>
				</div>
			)}
			{$if(
				use(this.locked),
				<form
					class="step"
					on:submit={(e: SubmitEvent) => {
						e.preventDefault();
						tryUnlock();
					}}
				>
					<p>Enter your password to load the game and your save.</p>
					<input
						type="password"
						autocomplete="current-password"
						placeholder="Password"
						bind:value={use(this.password)}
						on:input={(e: InputEvent) =>
							(this.password = (e.target as HTMLInputElement).value)
						}
						style="font: inherit; padding: 0.6em 0.8em; border-radius: 0.6em; border: 1px solid var(--surface4); background: var(--surface1); color: var(--fg);"
					/>
					<Button type="primary" icon="left" disabled={false} on:click={() => {}}>
						<Icon icon={iconEncrypted} />
						Enter
					</Button>
				</form>
			)}
			{$if(
				use(this.needsSetup),
				<div class="step">
					<p>
						<b>First-time setup.</b> There's no game copy online yet. Pick your
						Celeste folder on this PC (Documents &gt; My Games &gt; Celeste2).
						The game is copied, prepared, and sent online once (about 1.1 GB).
						Your save comes along too. After that, any device only needs the
						password.
					</p>
					<Button
						type="primary"
						icon="left"
						disabled={use(this.busy, (x) => x || FSAPI_UNAVAILABLE)}
						on:click={async () => {
							this.busy = true;
							this.status = "Clearing old files...";
							await removeLocalGame();
							this.status = "Starting the engine...";
							await this.start();
							this.status = "";
							this["on:next"]("copy");
						}}
					>
						<Icon icon={iconFolderOpen} />
						Choose Celeste folder
					</Button>
				</div>
			)}
			{$if(use(this.showProgress), <Progress percent={use(this.percent)} />)}
			{$if(use(this.status), <p>{use(this.status)}</p>)}
		</div>
	);
};

const UploadGame: Component<
	{ "on:done": () => void },
	{ status: string; percent: number; failed: boolean }
> = function () {
	this.status = "";
	this.percent = 0;
	this.failed = false;

	const run = async () => {
		this.failed = false;
		try {
			this.status =
				"Sending the game online (one time, about 1.1 GB). Keep this tab open.";
			await uploadGame((f) => (this.percent = f * 100));
			this.status = "Sending your save...";
			await syncNow();
			startSaveSync();
			this["on:done"]();
		} catch (e) {
			console.error(e);
			this.failed = true;
			this.status =
				e instanceof LockedError
					? "The password ran out during the upload. Reload the page and try again."
					: "The upload failed: " + e;
		}
	};
	queueMicrotask(run);

	return (
		<div class="step">
			<Progress percent={use(this.percent)} />
			<p>{use(this.status)}</p>
			{$if(
				use(this.failed),
				<Button
					type="primary"
					icon="left"
					disabled={false}
					on:click={() => location.reload()}
				>
					<Icon icon={iconCloudUpload} />
					Try again
				</Button>
			)}
		</div>
	);
};

const Progress: Component<{ percent: number }, {}> = function () {
	this.css = `
		background: color-mix(in srgb, var(--surface1) 70%, transparent);
		border-radius: 1rem;
		height: 0.6rem;

		.bar {
			background: var(--accent);
			border-radius: 1rem;
			height: 0.6rem;
			transition: width 100ms ease;
		}
	`;

	return (
		<div>
			<div class="bar" style={use`width:${this.percent}%`} />
		</div>
	);
};

const Extract: Component<
	{
		"on:done": () => void;
	},
	{
		extracting: boolean;
		status: string;
		percent: number;
		input: HTMLInputElement;
	}
> = function () {
	this.css = `
		/* hacky */
		.center svg {
			transform: translateY(15%);
		}

		.file-input { display: none }
	`;

	const opfs = async () => {
		const files: FileList = await new Promise((res, rej) => {
			this.input.value = "";
			this.input.oncancel = rej;
			this.input.onchange = () => res(this.input.files!);
			this.input.click();
		});
		const file = files[0];

		let parsedSize = 0;
		const fileSize = file.size;

		const stream = file.stream();
		const reader = stream.getReader();
		const self = this;
		let progressStream = new ReadableStream({
			async pull(controller) {
				const { value, done } = await reader.read();

				if (!value || done) {
					controller.close();
				} else {
					controller.enqueue(value);

					parsedSize += value.byteLength;
					self.percent = (parsedSize / fileSize) * 100;
				}
			},
		});

		this.extracting = true;

		if (file.name.endsWith(".gz"))
			progressStream = progressStream.pipeThrough(
				new DecompressionStream("gzip")
			);
		await extractTar(progressStream, rootFolder, (type, name) =>
			console.log(`untarred ${type} ${name}`)
		);

		this.extracting = false;

		event("assets-provided", { option: "archive" });
		this["on:done"]();
	};

	return (
		<div class="step">
			<p class="center">
				Select a {NAME} exported .tar archive of the root directory. You can
				create this on a browser with {NAME} already set-up by clicking the
				archive button (<Icon icon={iconArchive} />) in the filesystem explorer
				while in the root directory.
			</p>
			{$if(use(this.extracting), <Progress percent={use(this.percent)} />)}
			<input type="file" class="file-input" accept=".tar,.tar.gz,.gz,application/x-tar,application/gzip" bind:this={use(this.input)} />
			<Button
				on:click={opfs}
				type="primary"
				icon="left"
				disabled={use(this.extracting)}
			>
				<Icon icon={iconFolderZip} />
				Select {NAME} archive
			</Button>
			{$if(use(this.status), <div class="error">{use(this.status)}</div>)}
		</div>
	);
};

const Copy: Component<
	{
		"on:done": () => void;
	},
	{
		copying: boolean;
		os: string;
		status: string;
		percent: number;
	}
> = function () {
	const opfs = async () => {
		const directory = await showDirectoryPicker();
		const res = await validateDirectory(directory);
		if (res) {
			this.status = res;
			return;
		}

		const contentFolder = await directory.getDirectoryHandle("Content", {
			create: false,
		});

		const max = await countFolder(contentFolder);
		let cnt = 0;
		this.copying = true;
		const before = performance.now();
		await copyFolder(contentFolder, rootFolder, (x) => {
			cnt++;
			this.percent = (cnt / max) * 100;
			console.debug(`copied ${x}: ${((cnt / max) * 100).toFixed(2)}`);
		});
		const after = performance.now();
		console.debug(`copy took ${(after - before).toFixed(2)}ms`);

		let celesteExe;
		try {
			let orig = await directory.getDirectoryHandle("orig", { create: false });
			celesteExe = await orig.getFileHandle("Celeste.exe", { create: false });
			console.debug("found everest install");
		} catch {
			celesteExe = await directory.getFileHandle("Celeste.exe", {
				create: false,
			});
		}
		await copyFile(celesteExe, rootFolder);
		if (copyPcSaves) {
			const n = await copySavesFromFolder(directory);
			console.log(`copied ${n} save files from the Celeste folder`);
		}

		await new Promise((r) => setTimeout(r, 250));
		await rootFolder.getFileHandle(".ContentExists", { create: true });
		event("assets-provided", { option: "opfs" });
		this["on:done"]();
	};

	const opfsForBadBrowsers = async (transfer: DataTransferItem) => {
		// mdn told me to check for this
		let handle: FileSystemEntry | null;
		if (
			"getAsEntry" in transfer &&
			typeof (transfer as any).getAsEntry === "function"
		) {
			handle = (transfer as any).getAsEntry();
		} else {
			handle = transfer.webkitGetAsEntry();
		}

		const res = await validateDirectoryForBadBrowsers(handle);
		if (res) {
			this.status = res;
			return;
		}

		const directory = handle as FileSystemDirectoryEntry;
		await (async (entries: FileSystemEntry[]) => {
			const contentFolder = entries.find(
				(e) => e.name === "Content"
			) as FileSystemDirectoryEntry;
			const max = await countFolderForBadBrowsers(contentFolder);
			let cnt = 0;
			this.copying = true;
			const before = performance.now();
			await copyFolderForBadBrowsers(contentFolder, rootFolder, (x) => {
				cnt++;
				this.percent = (cnt / max) * 100;
				console.debug(`copied ${x}: ${((cnt / max) * 100).toFixed(2)}`);
			});
			const after = performance.now();
			console.debug(`copy took ${(after - before).toFixed(2)}ms`);

			let celesteExe;
			try {
				let orig = entries.find(
					(e) => e.name === "orig"
				) as FileSystemDirectoryEntry;
				let subEntries = await readAllEntries(orig);
				celesteExe = subEntries.find(
					(e) => e.name === "Celeste.exe"
				) as FileSystemFileEntry;
				console.debug("found everest install");
			} catch {
				celesteExe = entries.find(
					(e) => e.name === "Celeste.exe"
				) as FileSystemFileEntry;
			}

			await copyFileForBadBrowsers(celesteExe!, rootFolder);
			if (copyPcSaves) {
				const n = await copySavesFromDroppedFolder(directory);
				console.log(`copied ${n} save files from the dropped Celeste folder`);
			}
			await new Promise((r) => setTimeout(r, 250));
			await rootFolder.getFileHandle(".ContentExists", { create: true });

			event("assets-provided", { option: "opfs-bad" });
			this["on:done"]();
		})(await readAllEntries(directory));
	};

	let ua = navigator.userAgent;
	this.os = "";
	if (ua.includes("Win")) {
		this.os = "win";
	} else if (ua.includes("Mac")) {
		this.os = "darwin";
	} else if (ua.includes("Linux")) {
		this.os = "linux";
	}

	this.css = `
		code {
			overflow-wrap: break-word;
		}

		p {
			margin-block: 0.3em;
		}

		.droparea {
			position: relative;
			border: 2px dashed var(--surface6);
			color: var(--fg6);
			font-size: 1.05rem;
			font-weight: 500;
			border-radius: 1rem;
			padding: 2rem;
			text-align: center;
			background: color-mix(in srgb, var(--surface3) 45%, transparent);
			transition: border-color 0.2s ease;
		}

		.droparea.true {
			pointer-events: none;
			cursor: no-drop;

			* {
				cursor: no-drop;
			}

			background:  color-mix(in srgb, var(--bg-sub) 45%, transparent);
			color: var(--surface6);
			border-color: var(--surface4);
		}

		.droparea.dragover {
			border-color: var(--accent);
			color: color-mix(in srgb, var(--fg3) 92%, var(--accent));
			.dnd-bg-hover {
				transition: background-image 0.35s ease;
				background-image: radial-gradient(
					circle at center,
					color-mix(in srgb, var(--accent) 25%, transparent),
					transparent
				);
			}
		}

		.dnd-bg-hover {
			position: absolute;
			top: 0;
			left: 0;
			width: 100%;
			height: 100%;
			border-radius: 1rem;
			z-index: 9;
			transition: background-image 0.35s ease;
			background-image: radial-gradient(
				circle at center,
				color-mix(in srgb, var(--surface3) 5%, transparent),
				transparent
			);
		}

		.dnd-content {
			z-index: 10;
			position: relative;
		}

		.dnd-icon {
			font-size: 2.65rem;
		}
	`;

	return (
		<div class="step">
			<p>
				Select your <b>FNA</b> Celeste install's directory. It will be copied to
				browser storage and can be removed in the file manager.
			</p>
			{this.os == "win" ? (
				<p>
					The directory for Steam installs of Celeste on your OS is usually
					located in{" "}
					<code>C:\Program Files (x86)\Steam\steamapps\common\Celeste</code>.
				</p>
			) : null}
			{this.os == "darwin" ? (
				<p>
					The directory for Steam installs of Celeste on your OS is usually
					located in:
					<br />{" "}
					<code>
						~/Library/Application
						Support/Steam/steamapps/common/Celeste/Celeste.app/Contents/Resources
					</code>
				</p>
			) : null}
			{this.os == "linux" ? (
				<p>
					The directory for Steam installs of Celeste is usually located in{" "}
					<code>~/.steam/root/steamapps/common/Celeste</code>.
				</p>
			) : null}
			{this.os == "" ? (
				<p>
					The directory for Steam installs of Celeste is usually located in one
					of these locations:
					<ul>
						<li>
							<code>~/.steam/root/steamapps/common/Celeste</code>
						</li>
						<li>
							<code>C:\Program Files (x86)\Steam\steamapps\common\Celeste</code>
						</li>
						<li>
							<code>
								~/Library/Application
								Support/Steam/steamapps/common/Celeste/Celeste.app/Contents/Resources
							</code>
						</li>
					</ul>
				</p>
			) : null}
			<div class="warning">
				If you get an error stating it can't open the folder because it
				"contains system files", try copying it to another location first.
			</div>
			{$if(use(this.copying), <Progress percent={use(this.percent)} />)}
			{PICKERS_UNAVAILABLE ? null : (
				<Button
					on:click={opfs}
					type="primary"
					icon="left"
					disabled={use(this.copying)}
				>
					<Icon icon={iconFolderOpen} />
					Select Celeste directory
				</Button>
			)}
			<div
				class={use`droparea ${this.copying}`}
				on:drop={async (e: DragEvent) => {
					(
						(e.currentTarget || e.target) as HTMLElement | null
					)?.classList.remove("dragover");
					e.preventDefault();
					if (!e.dataTransfer || !e.dataTransfer.items || this.copying) return;
					const transfer = e.dataTransfer.items[0];
					await opfsForBadBrowsers(transfer);
				}}
				on:dragover={(e: DragEvent) => {
					e.preventDefault();
					e.dataTransfer!.dropEffect = "copy";
					if (this.copying) return;
					((e.currentTarget || e.target) as HTMLElement).classList.add(
						"dragover"
					);
				}}
				on:dragleave={(e: DragEvent) => {
					(
						(e.currentTarget || e.target) as HTMLElement | null
					)?.classList.remove("dragover");
				}}
			>
				<div class="dnd-bg-hover"></div>
				<div class="dnd-content">
					<Icon icon={iconCloudUpload} class="dnd-icon" />
					{PICKERS_UNAVAILABLE ? (
						<p>Drag and drop Celeste directory</p>
					) : (
						<p>Or, drag and drop one here</p>
					)}
				</div>
			</div>
			{$if(use(this.status), <div class="error">{use(this.status)}</div>)}
		</div>
	);
};

export const Download: Component<
	{
		"on:done": () => void;
	},
	{
		downloading: boolean;
		downloadDisabled: boolean;
		status: string;
		percent: number;
		input: HTMLInputElement;
	}
> = function () {
	this.css = `
		gap: 2.5rem;
		font-size: 15pt;

		.console {
			font-size: initial;
			height: 10em;
		}
	`;

	useChange([this.downloading, steamState.login], () => {
		this.downloadDisabled = this.downloading || steamState.login != 2;
	});

	const download = async () => {
		this.downloading = true;
		let result = await DownloadApp();
		this.downloading = false;
		if (result) {
			await rootFolder.getFileHandle(".ContentExists", { create: true });
			event("assets-provided", { option: "steam" });
			this["on:done"]();
		} else {
			console.error("FAILED TO DOWNLOAD. TRY RELOADING");
		}
	};

	const downloadscuffed = async () => {
		await pickDownloadsFolder();
		await download();
	};

	return (
		<div>
			{$if(
				use(gameState.ready),
				<div>
					{$if(
						use(steamState.login, (l) => l == 2),
						<div>
							<p>Logged into Steam successfully!</p>
							<Button
								type="primary"
								icon="left"
								disabled={use(this.downloadDisabled)}
								on:click={download}
							>
								<Icon icon={iconEncrypted} />
								Download Assets
							</Button>
							<Button
								type="primary"
								icon="left"
								disabled={use(this.downloadDisabled)}
								on:click={downloadscuffed}
							>
								<Icon icon={iconEncrypted} />
								Download Assets (scuffed) (chrome os only)
							</Button>
						</div>,
						<SteamLogin />
					)}

					{$if(use(this.downloading), <Progress percent={use(this.percent)} />)}
				</div>,
				<div class="loading">
					<p>Initializing Connection to Steam... ?</p>
				</div>
			)}

			{$if(
				use(steamState.login, (l) => l == 2),
				<div class="console">
					<LogView scrolling={false} />
				</div>
			)}
		</div>
	);
};

export const Patch: Component<
	{
		"on:done": () => void;
	},
	{
		patching: boolean;
		everest: boolean;
	}
> = function () {
	this.patching = false;
	this.everest = false;
	this.css = `
		display: flex;
		flex-direction: column;
		gap: 1rem;

		.component-log {
		  scrollbar-width: none;
		}

		.console {
			display: flex;
			font-size: initial;
			height: 10em;
		}
	`;
	const patch = async () => {
		this.patching = true;
		try {
			await PatchCeleste(this.everest);
			this.patching = false;
			event("patched", { everest: this.everest });
			this["on:done"]();
		} catch {
			console.debug("================================================");
			console.error("[!!!] There was an error patching Celeste!");
			console.log("Please try again or reload the page.");
			console.debug("================================================");
			this.patching = false;
		}
	};

	queueMicrotask(patch);

	return (
		<div>
			<p>Preparing the game for the browser (one time)...</p>

			<Button
				type="primary"
				icon="left"
				on:click={patch}
				disabled={use(this.patching)}
			>
				<Icon icon={iconManufacturing} />
				Try again
			</Button>

			<div class="console">
				<LogView scrolling={true} />
			</div>
		</div>
	);
};

export const Splash: Component<
	{
		"on:next": (animation: boolean) => void;
		start: () => Promise<void>;
	},
	{
		next: "intro" | "copy" | "extract" | "download" | "patch" | "upload";
		settingsOpen: boolean;
	}
> = function () {
	this.css = `
		position: relative;

		width: 100%;
		height: 100%;

		--animation: cubic-bezier(0.25, 0, 0.25, 1);

		.splash, .blur, .main {
			position: absolute;
			width: 100%;
			height: 100%;
			top: 0;
			left: 0;
		}

		.splash {
			object-fit: cover;
			z-index: 101;
		}

		.blur {
			backdrop-filter: blur(1rem);
			background-color: color-mix(in srgb, var(--bg) 35%, transparent);
			z-index: 102;
			transition: backdrop-filter .65s var(--animation) 0.35s, background-color .65s var(--animation) 0.35s;

			@starting-style {
	      backdrop-filter: blur(2.5rem);
  			background-color: color-mix(in srgb, var(--bg) 80%, transparent);
			}
		}

		.main {
			display: flex;
			align-items: center;
			justify-content: center;
			z-index: 103;
		}

		.container {
			backdrop-filter: blur(0.5vw);
			background-color: color-mix(in srgb, var(--bg) 80%, transparent);
      box-shadow: 0px 0px 20px color-mix(in srgb, var(--surface0) 40%, transparent);
			width: min(40rem, 100%);
			margin: 0 1rem;
			padding: 1.3em;
			border-radius: 1.5rem;

			color: var(--fg);

			display: flex;
			flex-direction: column;
			gap: 0.5rem;

			opacity: 1;
			transform: translateY(0vh) rotate3d(1, 0, 0, 0);
			transition: opacity .65s var(--animation) 0.35s, transform .65s var(--animation) 0.35s;
			transform-origin: 50% 0%;
			perspective: 1250px;

			@starting-style {
			  opacity: 0;
				transform: translateY(5vh) rotate3d(1, 0, 0, 15deg);
			}
		}

		.logo {
			display: flex;
			justify-content: center;
		}

		.step {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
		}

		.main > .container > .component-btn {
      width: 2.5em;
      position: fixed;
      right: 1.3rem;
		}
	`;
	this.next = "intro";
	this.settingsOpen = false;

	return (
		<div>
			<img alt="Splash image" class="splash" src="./splash.webp" />
			<div class="blur" />
			<div class="main">
				<div class="container">
					<div class="logo">
						<Logo />
					</div>
					{use(this.next, (x) => {
						if (x === "intro") {
							return (
								<CloudIntro
									start={this.start}
									on:next={(x) => {
										if (x === "done") {
											this["on:next"](false);
										} else if (x === "done-animated") {
											this["on:next"](true);
										} else {
											this.next = x;
										}
									}}
								/>
							);
						} else if (x === "copy") {
							return <Copy on:done={() => (this.next = "patch")} />;
						} else if (x === "extract") {
							return <Extract on:done={() => this["on:next"](true)} />;
						} else if (x === "download") {
							return <Download on:done={() => (this.next = "patch")} />;
						} else if (x === "patch") {
							return <Patch on:done={() => (this.next = "upload")} />;
						} else if (x === "upload") {
							return <UploadGame on:done={() => this["on:next"](true)} />;
						}
					})}
					<Button
						type="primary"
						icon="full"
						disabled={false}
						on:click={() => (this.settingsOpen = true)}
						title="Settings"
					>
						<Icon icon={iconSettings} />
					</Button>
				</div>
			</div>
			<Dialog name="Settings" bind:open={use(this.settingsOpen)}>
				<Settings />
			</Dialog>
		</div>
	);
};
