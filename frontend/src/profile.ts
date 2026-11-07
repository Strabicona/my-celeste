// Which link the page was opened with. Each link loads the same game with its
// own mod pack and keeps its own saves online:
//   ?mods=sj      Strawberry Jam
//   ?mods=dsides  Monika's D-Sides
export type Profile = {
	id: "sj" | "ds";
	label: string;
	pack: "mods-sj" | "mods-ds";
	// online save names are "<savePrefix>0.celeste", "<savePrefix>settings.celeste", ...
	savePrefix: string;
};

export const PROFILES: Record<Profile["id"], Profile> = {
	sj: { id: "sj", label: "Strawberry Jam", pack: "mods-sj", savePrefix: "sj~" },
	ds: { id: "ds", label: "D-Sides", pack: "mods-ds", savePrefix: "ds~" },
};

export const LINKS: Record<Profile["id"], string> = { sj: "sj", ds: "dsides" };

function pick(): Profile | null {
	const v = (new URLSearchParams(location.search).get("mods") || "").toLowerCase();
	if (v === "sj" || v === "strawberryjam") return PROFILES.sj;
	if (v === "dsides" || v === "ds" || v === "d-sides") return PROFILES.ds;
	return null;
}

export const profile: Profile | null = pick();

export function linkFor(id: Profile["id"]): string {
	const u = new URL(location.href);
	u.search = "";
	u.searchParams.set("mods", LINKS[id]);
	return u.toString();
}
