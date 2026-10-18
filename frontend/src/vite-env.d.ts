/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_STEAM_ENABLED: boolean;
	readonly WISP_URL: boolean;
	readonly VITE_API_BASE: string;
	readonly VITE_BUILD_ID?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
