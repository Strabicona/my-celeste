/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_STEAM_ENABLED: boolean;
	readonly WISP_URL: boolean;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
