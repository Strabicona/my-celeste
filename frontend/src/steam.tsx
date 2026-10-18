import { gameState, LogView } from "./game";
import { DownloadSteamCloud, initSteam, UploadSteamCloud } from "./game/dotnet";
import { TextField } from "./ui/TextField";
import { Button, Icon } from "./ui/Button";

import iconQrCodeScanner from "@ktibow/iconset-material-symbols/qr-code-scanner";
import iconLogin from "@ktibow/iconset-material-symbols/login";

export const steamState: Stateful<{
	login: number;
	qr: string;
}> = $state({
	login: 0,
	qr: "",
});

export const SteamCloud: Component<{
	open: boolean;
}> = function () {
	this.css = `
		height: 100%;
	`;

	return (
		<div>
			{$if(
				use(steamState.login, (l) => l == 2),
				<div>
					<p>Logged Into Steam</p>
					<Button
						type="normal"
						icon="none"
						on:click={() => DownloadSteamCloud()}
						disabled={false}
					>
						Download Steam Cloud
					</Button>
					<Button
						type="normal"
						icon="none"
						on:click={() => UploadSteamCloud()}
						disabled={false}
					>
						Upload Steam Cloud
					</Button>
					<LogView scrolling={true} />
				</div>,
				<div>
					<SteamLogin />
				</div>
			)}
		</div>
	);
};

export const SteamLogin: Component<
	{},
	{
		username: string;
		password: string;
	}
> = function () {
	this.css = `
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: space-between;
		height: min(42rem, calc(100vh - 8rem));
		gap: 1rem;
		// font-size: 15pt;
		font-size: 1rem;

		input[type="file"] {
			display: none;
		}

		.methods {
			display: flex;
			gap: 1rem;
		}
		.methods > div {
			flex: 1;
			display: flex;
			flex-direction: column;
			gap: 0.5rem;

			padding: 1rem;
		}

		.spacer {
			flex: 1;
			margin-top: 0.5em;
			margin-bottom: 0.5em;
			border-bottom: 1px solid var(--fg);
		}

		p {
			text-align: center;
		}

		h1, h3 {
			text-align: center;
			padding: 0;
			margin: 0;
		}

		.logcontainer {
			font-size: initial;
			height: 5em;
			display: flex;
		}

		.logs {
			width: 100%;
		}

		.qrcontainer {
			display: flex;
			justify-content: center;
			flex-direction: column;
			align-items: center;
			width: 100%;
		}

		.qrcontainer > div {
			background-color: var(--surface0);
			animation: load 1s infinite alternate;
			border-radius: 20px;
			width: 40%;
			aspect-ratio: 1;
		}

		@keyframes load {
			0% {
				background-color: var(--bg);
			}
			100% {
				background-color: var(--surface0);
			}
		}

		.qrcontainer img {
			width: 100%;
			border-radius: 20px;
			opacity: 1;
			transition: opacity 0.125s ease-in-out;

			@starting-style {
				opacity: 0;
			}
		}
  `;
	this.username = "";
	this.password = "";

	const loginqr = async () => {
		steamState.login = 1;
		let result = await initSteam(null, null, true);
		if (!result) {
			steamState.login = 3;
		} else {
			steamState.login = 2;
		}
	};

	const loginpass = async () => {
		steamState.login = 1;
		let result = await initSteam(this.username, this.password, false);
		if (!result) {
			this.username = "";
			this.password = "";
			steamState.login = 3;
		} else {
			steamState.login = 2;
		}
	};

	return (
		<div>
			<div>
				<div>
					<p>
						This will log into Steam through a proxy, so that it can download
						assets and achievement stats.
					</p>
					<p>
						Account credentials are encrypted on your device and never sent to a
						server. Still, beware of unofficial deployments.
					</p>
				</div>

				{$if(
					use(steamState.login, (l) => l == 0 || l == 3),
					<div class="methods">
						<div class="tcontainer">
							<h3>Username and Password</h3>
							<TextField
								bind:value={use(this.username)}
								placeholder={"Username"}
							/>
							<TextField
								bind:value={use(this.password)}
								type={"password"}
								placeholder={"Password"}
							/>
							<div style="flex: 1"></div>
							<Button
								type="primary"
								icon="left"
								disabled={use(gameState.ready, (r) => !r)}
								on:click={loginpass}
							>
								<Icon icon={iconLogin} />
								Log In
							</Button>
						</div>
						<div class="tcontainer">
							<h3>Steam Guard</h3>
							<p>Requires the Steam app on your phone to be installed.</p>
							<div style="flex: 1"></div>
							<Button
								type="primary"
								icon="left"
								disabled={use(gameState.ready, (r) => !r)}
								on:click={loginqr}
							>
								<Icon icon={iconQrCodeScanner} />
								Log In with QR Code
							</Button>
						</div>
					</div>
				)}
			</div>
			{$if(
				use(steamState.login, (l) => l == 3),
				<div style="color: var(--error)">Failed to log in! Try again</div>
			)}

			{$if(
				use(steamState.login, (l) => l == 1),
				<div class="qrcontainer">
					<div>
						{$if(
							use(steamState.qr),
							<img alt="Steam QR" src={use(steamState.qr)} />
						)}
					</div>

					{/* {$if(
						use(steamState.qr), */}
					<p>
						Scan this QR code with the Steam app on your phone. If the app
						complains about your location being wrong, just select the location
						that you don't usually log in from.
					</p>
					{/* )} */}
				</div>
			)}
			{$if(
				use(steamState.login, (l) => l == 3 || l == 1 || l == 2),
				<div class="logs">
					<h4>Logs</h4>
					<div class="logcontainer">
						<LogView scrolling={true} />
					</div>
				</div>
			)}
		</div>
	);
};
