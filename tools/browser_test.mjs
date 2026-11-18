// Automatic browser test (16 Nov 2026). Runs on GitHub (workflow
// "Browser test"): opens the site in a real Chrome, logs in with the site
// password from the repository secrets, and plays the hidden Strawberry Jam
// test link (?mods=testsj, throwaway saves "tsj~", never Afonso's).
//
// It runs the game twice, without and with per-lobby map loading (?slim=0 /
// default), and for each run records memory, full clean-ups per minute and the
// longest frame while standing in a lobby and in two maps, plus screenshots
// and every map's summary (strawberries, checkpoints) to compare.
//
// Results go to results/ (uploaded as the workflow's artifact).
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const BASE = process.env.MY_CELESTE_URL || "https://my-celeste.pages.dev";
const PASSWORD = process.env.SITE_PASSWORD;
if (!PASSWORD) throw new Error("SITE_PASSWORD is missing");
const RUNS = (process.env.RUNS || "off,on").split(",");
const STAY_S = Number(process.env.STAY_S || 120);
const OUT = "results";
fs.mkdirSync(OUT, { recursive: true });

const LOBBY = "StrawberryJam2021/0-Lobbies/2-Intermediate";
const MAP_A = "StrawberryJam2021/2-Intermediate/thebreadstick1";
const MAP_B = "StrawberryJam2021/4-Expert/Vina";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => {
	const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(" ")}`;
	console.log(line);
	fs.appendFileSync(`${OUT}/log.txt`, line + "\n");
};

const browser = await puppeteer.launch({
	executablePath: process.env.CHROME || "/usr/bin/google-chrome",
	headless: process.env.HEADLESS === "1" ? "new" : false,
	userDataDir: "/tmp/chrome-profile",
	protocolTimeout: 600000,
	args: [
		"--no-sandbox",
		"--use-angle=swiftshader",
		"--enable-unsafe-swiftshader",
		"--ignore-gpu-blocklist",
		"--autoplay-policy=no-user-gesture-required",
		"--disable-background-timer-throttling",
		"--disable-renderer-backgrounding",
		"--disable-backgrounding-occluded-windows",
		"--window-size=1280,800",
	],
	defaultViewport: { width: 1280, height: 800 },
});

const page = await browser.newPage();
const consoleLines = [];
page.on("console", (m) => {
	const t = m.text();
	consoleLines.push(t);
	if (/^\[(slim|test|gc|mods|saves|files|tabs)\]|LOAD:|DISPLAYED|Exception|went wrong|isolat|error/i.test(t)) log("console:", t.slice(0, 300));
});
page.on("pageerror", (e) => log("page error:", String(e).slice(0, 300)));

// log in once (the cookie stays in the profile)
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
if (await page.$('input[name="password"]')) {
	await page.type('input[name="password"]', PASSWORD);
	await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.click('button[type="submit"]')]);
	log("logged in");
}

const state = () =>
	page.evaluate(() => {
		const m = globalThis.__myCeleste;
		return m ? { scene: m.sceneInfo(), frames: { ...m.frameInfo } } : null;
	});

// the game's own password box (cloud saves), shown once per browser
async function unlockIfAsked() {
	const box = await page.$("form.step input[type=password]").catch(() => null);
	if (!box) return;
	await box.type(PASSWORD);
	await page.keyboard.press("Enter");
	log("entered the game password");
	await sleep(3000);
}

async function waitFor(what, test, timeoutS) {
	const until = Date.now() + timeoutS * 1000;
	let lastNote = 0;
	while (Date.now() < until) {
		await unlockIfAsked();
		const s = await state().catch(() => null);
		if (s && test(s)) return s;
		if (Date.now() - lastNote > 60000) {
			lastNote = Date.now();
			const text = await page.evaluate(() => document.body?.innerText?.slice(0, 160).replace(/\s+/g, " ")).catch((e) => "? " + e.message);
			log("waiting for", what, "| page:", text, "| state:", JSON.stringify(s));
		}
		await sleep(2000);
	}
	throw new Error("timed out waiting for " + what);
}

async function stay(label, seconds) {
	const start = await state();
	let worst = 0,
		lowFps = 999;
	const t0 = Date.now();
	while (Date.now() - t0 < seconds * 1000) {
		// a game key now and then, so auto-pause does not pause the level
		await page.keyboard.press("s").catch(() => {});
		for (let i = 0; i < 8; i++) {
			await sleep(1000);
			const s = await state();
			worst = Math.max(worst, s.frames.worstMs);
			if (s.frames.fps > 0) lowFps = Math.min(lowFps, s.frames.fps);
		}
	}
	const end = await state();
	const minutes = (Date.now() - t0) / 60000;
	const r = {
		label,
		memoryMB: end.scene.managedMB,
		fullCleanupsPerMin: +((end.scene.gen2 - start.scene.gen2) / minutes).toFixed(1),
		longestFrameMs: worst,
		lowestFps: lowFps,
		sceneState: end.scene.state,
	};
	log("measured", JSON.stringify(r));
	await page.screenshot({ path: `${OUT}/${run}-${label}.png` });
	return r;
}

// 18 Nov 2026: die every few seconds in a map, to see how fast memory piles
// up and where the clean-ups happen (loader/Breaks.cs)
async function dieLoop(label, seconds) {
	const seen = consoleLines.length;
	let worst = 0, lowFps = 999, wasmMax = 0, memMax = 0, deaths = 0;
	const t0 = Date.now();
	const stalls = [];
	while (Date.now() - t0 < seconds * 1000) {
		const r = await page.evaluate(async () => await globalThis.__myCeleste.die()).catch((e) => e.message);
		if (r === "ok") deaths++;
		for (let i = 0; i < 3; i++) {
			await sleep(1000);
			const s = await state();
			const w = await page.evaluate(() => globalThis.__myCeleste.wasmMB()).catch(() => 0);
			wasmMax = Math.max(wasmMax, w);
			memMax = Math.max(memMax, s.scene.managedMB);
			if (s.frames.worstMs > 100) stalls.push(s.frames.worstMs);
			worst = Math.max(worst, s.frames.worstMs);
			if (s.frames.fps > 0) lowFps = Math.min(lowFps, s.frames.fps);
		}
	}
	const gc = consoleLines.slice(seen).filter((l) => l.startsWith("[gc]"));
	const r = { label, seconds, deaths, highestMemoryMB: memMax, highestWasmMB: wasmMax, longestFrameMs: worst, lowestFps: lowFps, secondsWithStallOver100ms: stalls.length, gc };
	log("measured", JSON.stringify(r, null, 1));
	await page.screenshot({ path: `${OUT}/${run}-${label}.png` });
	return r;
}

async function enter(sid) {
	log("entering", sid);
	const r = await page.evaluate(async (s) => await globalThis.__myCeleste.load(s), sid);
	if (r !== "ok") throw new Error("load: " + r);
	await sleep(5000);
	await waitFor(sid + " playing", (s) => s.scene.state === 1 || s.scene.state === 2, 300);
	await sleep(8000);
}

const results = {};
let run = "";
for (run of RUNS) {
	const url = `${BASE}/?mods=testsj&autoplay=1${run === "off" ? "&slim=0" : ""}${run === "measure" ? "&breaks=0" : ""}`;
	log("=== run", run, url);
	await page.goto(url, { waitUntil: "domcontentloaded" });
	try {
		// startup: download (first run), then the engine, then the title screen
		const seen = consoleLines.length;
		const ready = () => consoleLines.slice(seen).some((l) => /^\[slim\] (on:|off|failed|title)/.test(l));
		await waitFor("title screen", (s) => s.scene.managedMB > 0 && s.frames.fps > 0 && ready(), 5400);
		const restarted = consoleLines.slice(seen).some((l) => l.startsWith("[slim] restarting"));
		log("restarted once after the first start:", restarted);
		await sleep(20000);
		const title = await state();
		const r = { titleMemoryMB: title.scene.managedMB };
		r.summaryAtTitle = await page.evaluate(async () => await globalThis.__myCeleste.summary());
		await page.screenshot({ path: `${OUT}/${run}-title.png` });
		if (process.env.RELINKER === "1") {
			r.relinkerList = await page.evaluate(async () => await globalThis.__myCeleste.relinker(false));
			log("relinker caches:\n" + r.relinkerList);
			r.relinkerClear = await page.evaluate(async () => await globalThis.__myCeleste.relinker(true));
			log("relinker cleared:\n" + r.relinkerClear);
			results[run] = r;
			fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 1));
			continue;
		}
		// 18 Nov 2026: clean-ups at breaks: measure ("measure" = old settings)
		if (run === "measure" || run === "breaks") {
			r.gcSettings = consoleLines.filter((l) => l.startsWith("[gc] settings") || l.startsWith("[gc] breaks")).slice(-2);
			await enter(MAP_A);
			r.dying = await dieLoop("dying", Number(process.env.DIE_S || 480));
			r.standing = await stay("standing", 60);
			results[run] = r;
			fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 1));
			continue;
		}
		// 17 Nov 2026: another computer takes over -> this one stops and offers Play here
		if (run === "takeover") {
			const seen2 = consoleLines.length;
			await page.evaluate(async () => await globalThis.__myCeleste.otherComputer());
			await waitFor("noticed the other computer", () => consoleLines.slice(seen2).some((l) => l.includes("[session] Celeste was opened on another")), 90);
			r.overlay = await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => b.textContent === "Play here"));
			await page.screenshot({ path: `${OUT}/takeover-overlay.png` });
			const seen3 = consoleLines.length;
			await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Play here").click());
			await waitFor("took over again and restarted", (st) => st.scene.managedMB > 0 && consoleLines.slice(seen3).some((l) => l.includes("[session] this computer is now")), 1800);
			r.tookOver = true;
			log("takeover:", JSON.stringify(r));
			results[run] = r;
			fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 1));
			continue;
		}
		// 17 Nov 2026: wipe the game files (keeping saves) and start again
		if (run === "wipe") {
			r.savesBefore = await page.evaluate(async () => await globalThis.__myCeleste.saveFiles());
			const seen2 = consoleLines.length;
			page.evaluate(() => globalThis.__myCeleste.wipe()).catch(() => {});
			await waitFor("wiped", () => consoleLines.slice(seen2).some((l) => l.startsWith("[wipe]")), 120);
			r.wipeLine = consoleLines.slice(seen2).find((l) => l.startsWith("[wipe]"));
			log(r.wipeLine);
			await sleep(5000);
			const seen3 = consoleLines.length;
			await waitFor("title again after the wipe", (st) => st.scene.managedMB > 0 && st.frames.fps > 0 && consoleLines.slice(seen3).some((l) => /^\[slim\] (on:|off|failed|title)/.test(l)), 5400);
			r.savesAfter = await page.evaluate(async () => await globalThis.__myCeleste.saveFiles());
			r.savesKept = r.savesBefore.every((n) => r.savesAfter.includes(n));
			log("wipe:", JSON.stringify(r));
			await page.screenshot({ path: `${OUT}/wipe-after.png` });
			results[run] = r;
			fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 1));
			continue;
		}
		if (process.env.DROP_ALL === "title") {
			r.dropAll = await page.evaluate(async () => await globalThis.__myCeleste.dropAllMaps());
			log("all maps dropped at the title:", r.dropAll);
			results[run] = r;
			continue;
		}
		await enter(LOBBY);
		r.lobby = await stay("lobby", STAY_S);
		await enter(MAP_A);
		r.mapA = await stay("intermediate-map", STAY_S);
		await enter(LOBBY);
		r.lobbyAgain = await stay("lobby-again", 30);
		await enter(MAP_B);
		r.mapB = await stay("expert-map", STAY_S);
		await enter(MAP_A);
		r.mapAAgain = await stay("intermediate-map-again", 30);
		r.summaryAtEnd = await page.evaluate(async () => await globalThis.__myCeleste.summary());
		if (process.env.DROP_ALL === "1") {
			r.dropAll = await page.evaluate(async () => await globalThis.__myCeleste.dropAllMaps());
			log("all maps dropped:", r.dropAll);
		}
		results[run] = r;
	} catch (e) {
		log("run", run, "failed:", e.message);
		await page.screenshot({ path: `${OUT}/${run}-failed.png` }).catch(() => {});
		results[run] = { error: e.message };
	}
	fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 1));
}

fs.writeFileSync(`${OUT}/console.txt`, consoleLines.join("\n"));
for (const [k, v] of Object.entries(results)) {
	if (v.error) continue;
	log(k, "title", v.titleMemoryMB, "MB | lobby", JSON.stringify(v.lobby), "| A", JSON.stringify(v.mapA), "| B", JSON.stringify(v.mapB));
}
await browser.close();
