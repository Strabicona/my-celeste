import { LogView } from ".";
import { NAME } from "../main";
import { Icon } from "../ui/Button";
import iconSettings from "@ktibow/iconset-material-symbols/settings";

// all the units are in vw so that it looks like it's in the game screen

export const splashState: Stateful<{
	text: string;
	modsFinished: number;
	modsTotal: number;
	progress: number;
}> = $state({
	text: "Initializing Celeste",
	modsFinished: 0,
	modsTotal: 1,
	progress: -1,
});

export const JsSplash = {
	StartSplash() {
		splashState.text = "Initializing Everest";
	},
	OnMessage(message: string) {
		let commands: string[] = [];

		if (message.startsWith("#progress")) {
			commands = message.substring(9).split(";");
			const loadedMods = parseInt(commands[0]);
			const totalMods = parseInt(commands[1]);
			const modName = commands[2];

			splashState.modsFinished = loadedMods;
			splashState.modsTotal = totalMods;
			splashState.progress = loadedMods / totalMods;
			splashState.text = `Loading mod ${modName}`;
		} else if (message.startsWith("#finish")) {
			commands = message.substring(7).split(";");

			const totalMods = parseInt(commands[0]);
			const msg = commands[1];

			splashState.modsFinished = totalMods;
			splashState.modsTotal = totalMods;
			splashState.progress = -1;
			splashState.text = msg;
		}
	},
	EndSplash() {
		splashState.progress = -1;
	},
};

const Progress: Component<{ indeterminate: boolean; progress: number }> =
	function () {
		this.css = `
		position: absolute;
		bottom: 0;
		left: 0;
		width: 100%;
		height: 0.5vw;
		z-index: 23;
		overflow: hidden;

		.value {
			background-color: white;
			height: 100%;
		}

		.value:not(.indeterminate) {
			transition: width 75ms;
			width: var(--percent);
		}

		.value.indeterminate {
			width: 100%;
			transform-origin: 0% 50%;
			animation: indeterminate 1s infinite cubic-bezier(0.2, 0.15, 0.5, 0.95);
		}

		@keyframes indeterminate {
			0% {
				transform: translateX(0) scaleX(0);
			}
			40% {
				transform: translateX(0) scaleX(0.4);
			}
			100% {
				transform: translateX(100%) scaleX(0.5);
			}
		}
	`;

		return (
			<div>
				<div
					class={use(this.indeterminate, (x) =>
						x ? "value indeterminate" : "value"
					)}
					style={use(this.progress, (x) => `--percent: ${x * 100}%;`)}
				/>
			</div>
		);
	};

export const Loader: Component<
	{},
	{
		logs: HTMLElement;
	}
> = function () {
	this.css = `
		position: relative;

		width: 100%;
		height: 100%;

		font-family: var(--font-display);
		background-color: var(--loader-bg);
		color: white;

		overflow: hidden;

		z-index: 10;

		/*--loader-width: min(calc(calc(100vh - var(--logsize) - 80px) * 16 / 9), 100vw);*/
		--loader-width: 100vw;

		.overlay {
			position: absolute;
			top: 0;
			left: 0;
			width: 100%;
			height: 100%;
			z-index: 23;
		}

		.main {
			display: flex;
			flex-direction: column;

			padding: calc(var(--loader-width) * 1.5 / 100);
		}

		.logs {
			display: flex;
			flex: 1;
			min-height: 0;
			padding-bottom: 0.5rem;
			mask-image: linear-gradient(to top, rgba(0, 0, 0, 1) 70%, rgba(0, 0, 0, 0.1) 90%, transparent 99%);
		}

		.modprogress {
			overflow: hidden;
			white-space: nowrap;
			text-overflow: ellipsis;
		}

		.progress-container {
			display: flex;
			justify-content: space-between;
			width: 100%;
		}

		.progress-text {
			overflow: hidden;
			white-space: nowrap;
			text-overflow: ellipsis;
		}

		.progress-counter {
			text-align: right;
			white-space: nowrap;
		}

		.bg {
			background-color: color-mix(in srgb, var(--loader-bg), white 1%);
			background-image: url("loader_gradient.webp");
			background-blend-mode: overlay;
			background-size: cover;

			opacity: 0.4;
			z-index: 21;
		}

		.gear {
			color: color-mix(in srgb, var(--loader-bg), white 35%);
			position: absolute;
			top: calc(var(--loader-width) * 5 / 100);
			right: calc(var(--loader-width) * 5 / 100);
			width: calc(var(--loader-width) * 105 / 100);
			height: calc(var(--loader-width) * 105 / 100);
			transform: translate(50%, -50%);

			animation: spin 12.5s infinite linear;

			filter: blur(8px);

			z-index: 20;
		}

		.bottom-bar {
			position: absolute;
			bottom: 0;
			left: 0;
			width: 100%;
			height: calc(min(max(14px, calc(var(--loader-width) * 2 / 100)), 20px) + calc(var(--loader-width) * 2.5 / 100));
			background-color: rgba(4, 0, 1, 0.6);
			backdrop-filter: blur(18px);
			z-index: 22;
		}

		.case {
			text-transform: capitalize;
		}

		.component-log {
			overflow-y: scroll !important;
			scrollbar-width: none;
		}

		.progresswrap {
			height: min(max(14px, calc(var(--loader-width) * 2 / 100)), 20px);
			margin-top: calc(var(--loader-width) * 1.25 / 100);
		}

		.large { font-size: min(max(26px, calc(var(--loader-width) * 4.1 / 100)), 40px); }
		.body { font-size: min(max(14px, calc(var(--loader-width) * 2 / 100)), 20px); }
		.smaller { font-size: min(max(10px, calc(var(--loader-width) * 1.5 / 100)), 16px); }

		@keyframes spin {
			100% { transform: translate(50%, -50%) rotate(360deg); }
		}
	`;

	return (
		<div class="loader">
			<div class="overlay main">
				<div class="large">
					Starting <span class="case">{NAME}</span>...
				</div>
				<div class="smaller logs dark" bind:this={use(this.logs)}>
					<LogView scrolling={false} />
				</div>
				<div class="progresswrap">
					{$if(
						use(splashState.text, (x) => x.length > 0),
						<div class="body progress-container">
							<div class="progress-text">{use(splashState.text)}</div>
							<div class="progress-counter">
								{use(splashState.modsFinished)}
								<span style="color: var(--fg6)">/</span>
								{use(splashState.modsTotal)}
							</div>
						</div>
					)}
				</div>
			</div>
			<Progress
				indeterminate={use(splashState.progress, (x) => x === -1)}
				progress={use(splashState.progress)}
			/>
			<div class="overlay bg" />
			<Icon class="gear" icon={iconSettings} />
			<div class="bottom-bar" />
		</div>
	);
};
