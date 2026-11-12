// Which link the page was opened with. Each link loads the same game with a
// mod pack; the no-sound links load the same pack without its music and sound
// (for phones with little memory) and share the saves of their sound version:
//   ?mods=sj              Strawberry Jam
//   ?mods=dsides          Monika's D-Sides
//   ?mods=sj-nosound      Strawberry Jam, no sound
//   ?mods=dsides-nosound  D-Sides, no sound
//   ?mods=plain           plain Celeste: no Everest, no mods, the original save
//   ?mods=test            hidden test link: D-Sides without sound, with its own
//                         throwaway saves ("test~"), never Afonso's (12 Nov 2026)
export type ProfileId = "sj" | "ds" | "sjq" | "dsq" | "plain" | "test";

export type Profile = {
	id: ProfileId;
	label: string;
	pack: "mods-sj" | "mods-ds" | null; // null: plain Celeste, no Everest, no mods
	noSound: boolean;
	// online save names are "<savePrefix>0.celeste", "<savePrefix>settings.celeste", ...
	savePrefix: string;
};

export const PROFILES: Record<ProfileId, Profile> = {
	sj: { id: "sj", label: "Strawberry Jam", pack: "mods-sj", noSound: false, savePrefix: "sj~" },
	ds: { id: "ds", label: "D-Sides", pack: "mods-ds", noSound: false, savePrefix: "ds~" },
	sjq: { id: "sjq", label: "Strawberry Jam", pack: "mods-sj", noSound: true, savePrefix: "sj~" },
	dsq: { id: "dsq", label: "D-Sides", pack: "mods-ds", noSound: true, savePrefix: "ds~" },
	// your original save (from before the mods), without Everest
	plain: { id: "plain", label: "Plain Celeste", pack: null, noSound: false, savePrefix: "" },
	test: { id: "test", label: "Test (throwaway saves)", pack: "mods-ds", noSound: true, savePrefix: "test~" },
};

export const LINKS: Record<ProfileId, string> = {
	sj: "sj",
	ds: "dsides",
	sjq: "sj-nosound",
	dsq: "dsides-nosound",
	plain: "plain",
	test: "test",
};

function pick(): Profile | null {
	const v = (new URLSearchParams(location.search).get("mods") || "").toLowerCase();
	if (v === "sj" || v === "strawberryjam") return PROFILES.sj;
	if (v === "dsides" || v === "ds" || v === "d-sides") return PROFILES.ds;
	if (v === "sj-nosound" || v === "sjq") return PROFILES.sjq;
	if (v === "dsides-nosound" || v === "dsq") return PROFILES.dsq;
	if (v === "plain" || v === "none" || v === "vanilla") return PROFILES.plain;
	if (v === "test") return PROFILES.test;
	return null;
}

export const profile: Profile | null = pick();

export function linkFor(id: ProfileId): string {
	const u = new URL(location.href);
	u.search = "";
	u.searchParams.set("mods", LINKS[id]);
	return u.toString();
}
