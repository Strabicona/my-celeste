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
	const url = `${BASE}/?mods=testsj&autoplay=1${run === "off" ? "&slim=0" : ""}`;
	log("=== run", run, url);
	await page.goto(url, { waitUntil: "domcontentloaded" });
	try {
		// startup: download (first run), then the engine, then the title screen
		const seen = consoleLines.length;
		await waitFor("title screen", (s) => s.scene.managedMB > 0 && s.frames.fps > 0 && consoleLines.slice(seen).some((l) => l.includes("LEVELS LOAD")), 3600);
		// per-lobby loading drops the rooms once the title screen is up
		if (run === "on") {
			const t0 = Date.now();
			while (!consoleLines.slice(seen).some((l) => l.startsWith("[slim] on:") || l.startsWith("[slim] off") || l.startsWith("[slim] failed")) && Date.now() - t0 < 300000) await sleep(2000);
		}
		await sleep(20000);
		const title = await state();
		const r = { titleMemoryMB: title.scene.managedMB };
		r.summaryAtTitle = await page.evaluate(async () => await globalThis.__myCeleste.summary());
		await page.screenshot({ path: `${OUT}/${run}-title.png` });
		await enter(LOBBY);
		r.lobby = await stay("lobby", STAY_S);
		await enter(MAP_A);
		r.mapA = await stay("intermediate-map", STAY_S);
		await enter(MAP_B);
		r.mapB = await stay("expert-map", STAY_S);
		r.summaryAtEnd = await page.evaluate(async () => await globalThis.__myCeleste.summary());
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
