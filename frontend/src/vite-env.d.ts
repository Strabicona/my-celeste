/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_STEAM_ENABLED: boolean;
	readonly WISP_URL: boolean;
	readonly VITE_GOOGLE_CLIENT_ID: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
