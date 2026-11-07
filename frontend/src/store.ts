export let store = $store(
	{
		logs: 0,

		theme:
			window.matchMedia &&
			window.matchMedia("(prefers-color-scheme: light)").matches
				? "light"
				: "dark",

		wispServer: import.meta.env.VITE_WISP_URL || "wss://anura.pro",
		epoxyVersion: "",
		accentColor: undefined,

		analytics: true,

		// on-screen controls (Mobile mode), remembered per device
		controls: "pc" as "pc" | "mobile",
		joystickMode: "fixed" as "fixed" | "floating",
		joyX: 0.16,
		joyY: 0.72,
		touchEdit: false,
	},
	{ ident: "options", backing: "localstorage", autosave: "auto" }
);

if (typeof store.analytics === "undefined") store.analytics = true;
if (store.controls !== "mobile") store.controls = "pc";
if (store.joystickMode !== "floating") store.joystickMode = "fixed";
if (typeof store.joyX !== "number") store.joyX = 0.16;
if (typeof store.joyY !== "number") store.joyY = 0.72;
store.touchEdit = false;

(self as any).store = store;
