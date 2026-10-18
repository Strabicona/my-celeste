import { loadedLibcurlPromise } from "./game/index";
import { TextField } from "./ui/TextField";
import { Button, Icon } from "./ui/Button";
import { rootFolder } from "./fs";
import { epoxyFetch } from "./epoxy";
import iconSearch from "@ktibow/iconset-material-symbols/search";
import iconDownload from "@ktibow/iconset-material-symbols/download";

type Mod = {
	Screenshots: string[];
	PageURL: string;
	Name: string;
	Text: string;
	Files: {
		URL: string;
		Name: string;
	}[];
};

export const ModInstaller: Component<
	{
		open: boolean;
	},
	{
		entries: Mod[];
		query: string;
	}
> = function () {
	// https://maddie480.ovh/celeste/gamebanana-categories
	// https://maddie480.ovh/celeste/gamebanana-subcategories?itemtype=...&categoryId=...

	this.query = "";
	this.entries = [];
	this.css = `
		height: 100%;

		.mods {
			overflow: auto;

			img {
				width: auto;
				height: 5rem;
				border: 0px solid transparent!important;
			}
		}

		.mod {
			display: flex;
			flex-direction: row;
			align-items: start;
			position: relative;
			margin-bottom: 1rem;
			border-radius: 14px;
			overflow: hidden;
			box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
			transition: transform 0.2s ease, box-shadow 0.2s ease;
			min-height: 12rem;
			width: calc(100% - 10px);
			margin-left: 5px;
		}

		.mod:hover {
			transform: scale(1.01);
			box-shadow: 0 6px 12px rgba(0, 0, 0, 0.25);
		}

		.bg {
			z-index: 9000;
			position: absolute;
			top: 0;
			left: 0;
			width: 100%!important;
			height: 100%!important;
			border: 0;
			object-fit: cover;
		}

		.gradient-overlay {
			content: "";
			position: absolute;
			top: 0;
			left: 0;
			width: 100%;
			height: 100%;
			background: linear-gradient(to bottom, rgba(0,0,0,0.6), rgba(0,0,0,0.9));
			z-index: 9001;
		}

		.mod,
		.detail {
			z-index: 9002;
		}

		.detail {
			padding: 1.25rem;
			width: calc(100% - 60px);

			h2 {
				margin-top: 0;
				color: #fff;
				text-shadow: 0 1px 3px rgba(0,0,0,0.5);
				font-size: 1.4rem;
			}

			p {
				color: rgba(255, 255, 255, 0.9);
				text-shadow: 0 1px 2px rgba(0,0,0,0.3);
				font-size: 0.9rem;
				line-height: 1.4;
				margin-bottom: 0.75rem;
			}
		}

		.screenshots {
			display: flex;
			flex-direction: row;
			overflow-x: auto;
			white-space: nowrap;
			gap: 0.5rem;
			padding: 0.5rem 0;
			width: 100%;
			scrollbar-width: thin;
			-webkit-overflow-scrolling: touch;
			margin-top: 0.5rem;

			img {
				flex: 0 0 auto;
				height: 5rem;
				border-radius: 4px;
				box-shadow: 0 2px 4px rgba(0,0,0,0.3);
				transition: transform 0.2s ease;
			}

			img:hover {
				transform: scale(1.05);
			}
		}

		.moddownload {
			position: absolute;
			right: 1rem;
			top: 1rem;
			margin: 0;
			z-index: 9003;
			border-radius: 50%;
			width: 42px;
			height: 42px;
			display: flex;
			align-items: center;
			justify-content: center;
			box-shadow: 0 2px 6px rgba(0,0,0,0.3);
			transition: transform 0.2s ease;
		}

		.moddownload:hover {
			transform: scale(1.1);
		}

		#modsearch {
			display: flex;
			gap: 0.5rem;
			padding: 0.25rem 0.5rem 1rem;
			position: sticky;
			top: 0;
			z-index: 10000;
			background: radial-gradient(ellipse at bottom, color-mix(in srgb, var(--bg-sub) 85%, transparent), var(--bg-sub));
			backdrop-filter: blur(5px);
		}

		.modsearchbar {
			flex-grow: 1;
		}

		.empty-message {
			text-align: center;
			padding: 2rem;
			color: rgba(255,255,255,0.7);
			font-style: italic;
		}
	`;

	const loadFrom = async (url: string) => {
		await loadedLibcurlPromise;
		let res = await epoxyFetch(url);
		this.entries = [];

		let entries: Mod[] = await res.json();
		this.entries = entries.map((e) => $state(e));
	};

	useChange([this.open, this.entries], async () => {
		if (this.open) {
			await loadedLibcurlPromise;
			for (const e of this.entries) {
				for (let i = 0; i < e.Screenshots.length; i++) {
					let url = e.Screenshots[i];
					if (url.startsWith("blob:")) continue;
					e.Screenshots[i] = "";
					await new Promise((r) => setTimeout(r, 100));
					epoxyFetch(url)
						.then((b) => b.blob())
						.then((blob) => {
							let url = URL.createObjectURL(blob);
							e.Screenshots[i] = url;
							e.Screenshots = e.Screenshots;
						});
				}
			}
		}
	});

	const search = async () => {
		console.log(this.query);
		await loadFrom(
			"https://maddie480.ovh/celeste/gamebanana-search?q=" + this.query
		);
		this.query = "";
	};

	const download = async (mod: Mod) => {
		let celeste = await rootFolder.getDirectoryHandle("Celeste", {
			create: true,
		});
		let mods = await celeste.getDirectoryHandle("Mods", { create: true });

		try {
			await mods.getFileHandle(mod.Files[0].Name, { create: false });
			alert("Mod already installed");
			return;
		} catch (e) {}

		let resp = await epoxyFetch(mod.Files[0].URL);
		let modfile = await mods.getFileHandle(mod.Files[0].Name, { create: true });
		let writable = await modfile.createWritable();
		// @ts-expect-error
		await resp.body.pipeTo(writable);

		console.log("Downloaded mod");
	};

	this.mount = async () => {
		loadFrom("https://maddie480.ovh/celeste/gamebanana-featured");
	};

	return (
		<div>
			<div id="modsearch">
				<TextField
					placeholder={"Search mods..."}
					on:keydown={(e: any) => {
						this.query = e.target.value;
						e.key === "Enter" && search();
					}}
					bind:value={use(this.query)}
					class={"modsearchbar"}
				/>
				<Button
					on:click={search}
					class={"searchbtn"}
					type={"primary"}
					icon={"full"}
					disabled={false}
				>
					<Icon icon={iconSearch} />
				</Button>
			</div>
			<div class="mods">
				{$if(
					use(this.entries, (entries) => entries.length === 0),
					<div class="empty-message">
						No mods found! Try searching for something else
					</div>
				)}
				{use(this.entries, (e) =>
					e.map((e) => (
						<div class="mod">
							<img
								class="bg"
								src={use(e.Screenshots, (s) =>
									s[0].startsWith("blob:") ? s[0] : ""
								)}
							/>
							<div class="gradient-overlay"></div>
							<div class="detail">
								<h2>{e.Name}</h2>
								{(() => {
									let p = <p />;
									p.innerHTML = e.Text;
									return p;
								})()}
								<div class="screenshots">
									{use(e.Screenshots, (e) =>
										e
											.slice(1)
											.filter((x) => x.startsWith("blob:"))
											.map((s) => <img src={s} />)
									)}
								</div>
							</div>
							<Button
								on:click={() => {
									download(e);
								}}
								icon="full"
								type="primary"
								class="moddownload"
								disabled={false}
								title={"Download Mod"}
							>
								<Icon icon={iconDownload} />
							</Button>
						</div>
					))
				)}
			</div>
		</div>
	);
};
