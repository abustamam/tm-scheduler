/**
 * Captures the real screenshots `/tour` shows (#867, #901):
 *
 *   public/landing/tour-agenda.png   ← /club/<slug>/meeting/<id>/print
 *   public/landing/tour-present.png  ← /club/<slug>/meeting/<id>/present
 *   public/landing/tour-vpe.png      ← /admin/vpe-dashboard#close-to-a-level,
 *                                      signed in as Harbor's VP Education
 *   public/landing/tour-vpm.png      ← /admin/vp-membership#guest-pipeline,
 *                                      signed in as Harbor's VP Membership
 *
 * Run: bun run marketing:screenshots
 *
 * PRECONDITIONS
 *   1. A local database FRESHLY seeded with `bun run db:seed`, reachable
 *      through `DATABASE_URL` in `.env.local` (Bun loads it). The images show
 *      only the seed's fictional club, Harbor City Speakers, and its fictional
 *      members. Never point this at a database holding a real club.
 *   2. `ENABLE_DEV_LOGIN=1 bun run dev` serving that same database on
 *      http://localhost:3000 (override with `BASE_URL`, which must stay on
 *      localhost or 127.0.0.1). The two officer shots sign in through the
 *      dev-only `/api/dev-login` (`src/routes/api/dev-login.ts`): it issues a
 *      real magic link server-side and hands the browser to Better Auth's own
 *      verify endpoint. Nothing here mints a cookie.
 *   3. A headless Chrome, found the way the print gates find it:
 *      `findChrome()` from `src/test/print-page-count.ts` tries `$CHROME_PATH`,
 *      then the usual binary names. On macOS set `CHROME_PATH` (CLAUDE.md
 *      says which binary works and which one hangs).
 *
 * Exits non-zero, naming what is missing, when `BASE_URL` is not local, when
 * Chrome, the club, a qualifying meeting, an upcoming meeting or either seed
 * officer is absent, when dev-login is off, when a page does not serve the club
 * or fails its DOM check, or when a capture comes out too small to be anything
 * but a blank page.
 */
import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHROME_ENV, findChrome } from "#/test/print-page-count";
import {
	checkVpeDom,
	checkVpmDom,
	devLoginPreflightError,
	devLoginUrl,
	framingProblem,
	isLocalBaseUrl,
	type SectionFrame,
	VPE_SECTION_ID,
	VPM_SECTION_ID,
} from "./marketing-screenshot-checks";

const CLUB_NAME = "Harbor City Speakers";
/** A meeting qualifies with at least this many filled role slots. */
const MIN_ASSIGNED_SLOTS = 3;
/** A blank or error page renders well under this; a real agenda well over. */
const MIN_PNG_BYTES = 20 * 1024;
const BASE_URL = (process.env.BASE_URL ?? "http://localhost:3000").replace(
	/\/$/,
	"",
);
const OUT_DIR = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../public/landing",
);

function fail(message: string): never {
	console.error(`marketing:screenshots: ${message}`);
	process.exit(1);
}

/**
 * The earliest qualifying meeting dated today or later, else the most recent
 * qualifying past one. `candidates` holds only qualifying meetings.
 */
function pickMeeting<T extends { scheduledAt: Date }>(
	candidates: T[],
	now: Date,
): T | null {
	const startOfToday = new Date(now);
	startOfToday.setHours(0, 0, 0, 0);
	const upcoming = candidates
		.filter((m) => m.scheduledAt >= startOfToday)
		.sort((a, b) => +a.scheduledAt - +b.scheduledAt);
	if (upcoming[0]) return upcoming[0];
	const past = candidates
		.filter((m) => m.scheduledAt < startOfToday)
		.sort((a, b) => +b.scheduledAt - +a.scheduledAt);
	return past[0] ?? null;
}

async function findTarget(): Promise<{ slug: string; meetingId: string }> {
	// Imported here, after the Chrome check, so a missing browser is reported
	// without needing a database at all.
	const { db } = await import("#/db");
	const { clubs, meetings, roleSlots } = await import("#/db/schema");
	const { and, count, eq, gte, isNotNull, or } = await import("drizzle-orm");

	const [club] = await db
		.select({ id: clubs.id, slug: clubs.slug })
		.from(clubs)
		.where(eq(clubs.name, CLUB_NAME))
		.limit(1);
	if (!club) {
		fail(
			`club "${CLUB_NAME}" not found. Seed the database first (bun run db:seed).`,
		);
	}

	const qualifying = await db
		.select({ id: meetings.id, scheduledAt: meetings.scheduledAt })
		.from(meetings)
		.innerJoin(roleSlots, eq(roleSlots.meetingId, meetings.id))
		.where(
			and(
				eq(meetings.clubId, club.id),
				or(
					isNotNull(roleSlots.assignedMemberId),
					isNotNull(roleSlots.assignedGuestId),
				),
			),
		)
		.groupBy(meetings.id, meetings.scheduledAt)
		.having(gte(count(roleSlots.id), MIN_ASSIGNED_SLOTS));

	const meeting = pickMeeting(qualifying, new Date());
	if (!meeting) {
		fail(
			`club "${CLUB_NAME}" has no meeting with at least ${MIN_ASSIGNED_SLOTS} assigned role slots.`,
		);
	}
	return { slug: club.slug, meetingId: meeting.id };
}

/** A 200 whose HTML names the club, or the capture would show the wrong thing. */
async function assertServes(url: string): Promise<void> {
	let res: Response;
	try {
		res = await fetch(url);
	} catch (err) {
		fail(
			`could not reach ${url} (${(err as Error).message}). Is \`bun run dev\` running?`,
		);
	}
	if (res.status !== 200) fail(`${url} answered ${res.status}, not 200.`);
	const html = await res.text();
	if (!html.includes(CLUB_NAME)) {
		fail(`${url} served a page that does not mention "${CLUB_NAME}".`);
	}
}

async function findClubId(): Promise<string> {
	const { db } = await import("#/db");
	const { clubs } = await import("#/db/schema");
	const { eq } = await import("drizzle-orm");
	const [club] = await db
		.select({ id: clubs.id })
		.from(clubs)
		.where(eq(clubs.name, CLUB_NAME))
		.limit(1);
	if (!club) fail(`club "${CLUB_NAME}" not found. Seed the database first.`);
	return club.id;
}

/**
 * The Harbor officers the two dashboard shots sign in as: the memberships with
 * an OPEN `vp_education` / `vp_membership` term, and the sign-in email of the
 * account behind each. Read from the database rather than hard-coded, so a seed
 * that renames them cannot leave the script signing in as nobody.
 */
async function findOfficerEmails(clubId: string): Promise<{
	vpeEmail: string;
	vpmEmail: string;
}> {
	const { db } = await import("#/db");
	const { members, officerTerms, people, user } = await import("#/db/schema");
	const { and, eq, isNull } = await import("drizzle-orm");

	async function officerEmail(
		position: "vp_education" | "vp_membership",
	): Promise<string> {
		const [row] = await db
			.select({ email: user.email })
			.from(officerTerms)
			.innerJoin(members, eq(members.id, officerTerms.membershipId))
			.innerJoin(people, eq(people.id, members.personId))
			.innerJoin(user, eq(user.id, people.userId))
			.where(
				and(
					eq(members.clubId, clubId),
					eq(officerTerms.position, position),
					isNull(officerTerms.termEnd),
				),
			)
			.limit(1);
		if (!row) {
			fail(
				`"${CLUB_NAME}" has no member with an open ${position} term and a sign-in account. Re-seed (bun run db:seed).`,
			);
		}
		return row.email;
	}

	return {
		vpeEmail: await officerEmail("vp_education"),
		vpmEmail: await officerEmail("vp_membership"),
	};
}

/**
 * The VPM shot needs two meetings still ahead: one for the "Invite to …"
 * control (the club's next meeting), and the one the seed's guest invite
 * points at, or its line reads "Last invited to …" and the DOM check fails.
 * The seed puts that invite on a meeting at least 7 days out, so a seed stays
 * good for a week; this names the failure when it has gone stale.
 */
async function assertUpcomingMeetings(clubId: string): Promise<void> {
	const { db } = await import("#/db");
	const { guestInvites, meetings } = await import("#/db/schema");
	const { and, desc, eq, gt, ne } = await import("drizzle-orm");
	const now = new Date();

	const [upcoming] = await db
		.select({ id: meetings.id })
		.from(meetings)
		.where(
			and(
				eq(meetings.clubId, clubId),
				gt(meetings.scheduledAt, now),
				ne(meetings.status, "cancelled"),
			),
		)
		.limit(1);
	if (!upcoming) {
		fail(
			`re-seed: no upcoming meeting for "${CLUB_NAME}" (bun run db:seed). The VPM shot's invite control needs one.`,
		);
	}

	const [invited] = await db
		.select({ at: meetings.scheduledAt })
		.from(guestInvites)
		.innerJoin(meetings, eq(meetings.id, guestInvites.meetingId))
		.where(eq(guestInvites.clubId, clubId))
		.orderBy(desc(meetings.scheduledAt))
		.limit(1);
	if (!invited) {
		fail(
			`re-seed: "${CLUB_NAME}" has no guest invite (bun run db:seed). The VPM shot's "Invited to" line needs one.`,
		);
	}
	if (invited.at <= now) {
		fail(
			`re-seed: "${CLUB_NAME}"'s latest guest invite is for ${invited.at.toISOString()}, which has passed, so the VPM shot would read "Last invited to" (bun run db:seed).`,
		);
	}
}

/**
 * Dev-login must answer 302 before Chrome is pointed at it: a 404 means the
 * server is not running with ENABLE_DEV_LOGIN=1, and a 500 names the email it
 * could not sign in. Issues (and abandons) one magic link.
 */
async function assertDevLogin(email: string): Promise<void> {
	const url = devLoginUrl(BASE_URL, email, "/");
	let res: Response;
	try {
		res = await fetch(url, { redirect: "manual" });
	} catch (err) {
		fail(
			`could not reach ${url} (${(err as Error).message}). Is \`ENABLE_DEV_LOGIN=1 bun run dev\` running?`,
		);
	}
	const problem = devLoginPreflightError(res.status, await res.text());
	if (problem) fail(problem);
}

/**
 * The flags every Chrome run here shares, with a fresh `--user-data-dir`, so
 * the DOM check, the `--screenshot` shots and the DevTools shots all load the
 * page the same way.
 */
function chromeArgs(profile: string, windowSize: string): string[] {
	return [
		"--headless",
		"--disable-gpu",
		"--no-sandbox",
		"--disable-extensions",
		`--user-data-dir=${profile}`,
		"--hide-scrollbars",
		`--window-size=${windowSize}`,
	];
}

/**
 * One headless Chrome run with a fresh profile. `output` is `--screenshot=…`
 * or `--dump-dom`. Returns stdout (the DOM, for a dump). `fail` runs only
 * after the profile is removed: it exits the process, so a `finally` it was
 * called inside would never run.
 */
function runChrome(
	chrome: string,
	url: string,
	windowSize: string,
	output: string,
): string {
	const profile = mkdtempSync(join(tmpdir(), "marketing-shot-"));
	let stdout: string | undefined;
	let error: string | undefined;
	try {
		stdout = execFileSync(
			chrome,
			[
				...chromeArgs(profile, windowSize),
				// NOT `--virtual-time-budget=8000`, which #867 specified: against
				// `bun run dev` it never returns. Vite's HMR websocket stays open, so
				// virtual time never runs out, and Chrome sat there until the 40s
				// ceiling on every attempt. Without it Chrome shoots once the page
				// has loaded (~1s here, fonts included); `--timeout` is the
				// ceiling on that wait.
				"--timeout=8000",
				output,
				url,
			],
			{
				env: CHROME_ENV,
				stdio: "pipe",
				timeout: 60_000,
				maxBuffer: 64 * 1024 * 1024,
			},
		).toString("utf8");
	} catch (err) {
		error = (err as Error).message;
	} finally {
		rmSync(profile, { recursive: true, force: true });
	}
	if (stdout === undefined) fail(`Chrome failed on ${url}: ${error}`);
	return stdout;
}

function capture(chrome: string, url: string, out: string): void {
	// Remove any earlier capture first, so a Chrome that writes nothing cannot
	// pass the checks below on the previous run's file.
	rmSync(out, { force: true });
	runChrome(chrome, url, "1600,1000", `--screenshot=${out}`);
	assertPng(out, url);
}

function assertPng(out: string, url: string): void {
	if (!existsSync(out)) fail(`Chrome wrote no screenshot for ${url}.`);
	const bytes = statSync(out).size;
	if (bytes <= MIN_PNG_BYTES) {
		fail(
			`${out} is ${bytes} bytes, under ${MIN_PNG_BYTES}: that is a blank page, not a capture.`,
		);
	}
	console.log(`wrote ${out} (${Math.round(bytes / 1024)} KB) from ${url}`);
}

/** The two signed-in dashboard shots, at 1600x900 with the section at the top. */
const OFFICER_WINDOW = "1600,900";
const OFFICER_VIEWPORT = { width: 1600, height: 900 };
/** After `load`: hydration, the post-mount draft links, fonts. */
const SETTLE_MS = 1500;
const CAPTURE_TIMEOUT_MS = 60_000;

/**
 * A signed-in section shot, taken over the DevTools protocol rather than with
 * `--screenshot`.
 *
 * WHY NOT `--screenshot` (#901, measured on Chrome 153 and on Playwright's
 * chrome-headless-shell 1234): when the page is SCROLLED — which is exactly
 * what the fragment does — the CLI screenshot comes back as the page
 * background with no content. A static 120-paragraph file with `#t` in the
 * middle reproduces it with no app involved: 6303 bytes of flat colour, while
 * `Page.captureScreenshot` of the same tab shows the target. So the fragment
 * still does the positioning and nothing is cropped; only the shutter differs.
 *
 * No new dependency: Chrome prints its DevTools WebSocket URL on stderr, and
 * Bun has a WebSocket client. Also measured here, not assumed: the section's
 * position (`framingProblem`) and the same DOM check the dump passed, on the
 * very page being shot.
 *
 * Every failure inside THROWS, and `fail` runs only after the `finally` has
 * killed Chrome and removed its profile. `fail` exits the process, so calling
 * it inside the `try` would skip the cleanup and leave a Chrome listening on a
 * debugging port.
 */
async function captureSection(
	chrome: string,
	url: string,
	out: string,
	sectionId: string,
	check: (html: string) => string | null,
): Promise<void> {
	rmSync(out, { force: true });
	const profile = mkdtempSync(join(tmpdir(), "marketing-shot-"));
	const proc = spawn(
		chrome,
		[
			...chromeArgs(profile, OFFICER_WINDOW),
			"--remote-debugging-port=0",
			"about:blank",
		],
		// Its own process group, so cleanup can kill the renderer and GPU
		// children too, not just the browser process.
		{ env: CHROME_ENV, stdio: ["ignore", "ignore", "pipe"], detached: true },
	);
	const exited = new Promise<void>((res) => {
		if (proc.exitCode !== null || proc.signalCode !== null) res();
		else proc.once("exit", () => res());
	});
	let deadline: ReturnType<typeof setTimeout> | undefined;
	let socket: WebSocket | undefined;
	let error: string | undefined;
	try {
		const top = await Promise.race([
			shootSection(proc, url, out, sectionId, check, (ws) => {
				socket = ws;
			}),
			new Promise<never>((_, rej) => {
				deadline = setTimeout(
					() => rej(new Error(`did not finish within ${CAPTURE_TIMEOUT_MS / 1000}s`)),
					CAPTURE_TIMEOUT_MS,
				);
			}),
		]);
		console.log(
			`#${sectionId} framed ${Math.round(top)}px from the top of ${OFFICER_VIEWPORT.height}px`,
		);
	} catch (err) {
		error = (err as Error).message;
	} finally {
		clearTimeout(deadline);
		socket?.close();
		await killChrome(proc, exited);
		// Only once every Chrome process is gone: removing the profile while a
		// child is still writing into it left the directory behind (measured:
		// two per run, before this waited).
		rmSync(profile, { recursive: true, force: true });
	}
	if (error !== undefined) fail(`Chrome failed on ${url}: ${error}`);
	assertPng(out, url);
}

/** SIGKILL Chrome's whole process group and wait for the browser to exit. */
async function killChrome(
	proc: ReturnType<typeof spawn>,
	exited: Promise<void>,
): Promise<void> {
	try {
		if (proc.pid !== undefined) process.kill(-proc.pid, "SIGKILL");
	} catch {
		// Already gone.
	}
	await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
}

/** The DevTools half of `captureSection`. Throws; never calls `fail`. Returns
 *  the section's measured top. */
async function shootSection(
	proc: ReturnType<typeof spawn>,
	url: string,
	out: string,
	sectionId: string,
	check: (html: string) => string | null,
	onSocket: (ws: WebSocket) => void,
): Promise<number> {
	const browserWs = await new Promise<string>((res, rej) => {
		let stderr = "";
		proc.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
			const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
			if (m) res(m[1]);
		});
		proc.on("exit", (code) =>
			rej(new Error(`Chrome exited (${code}) before DevTools came up`)),
		);
	});
	const port = new URL(browserWs).port;
	const targets = (await (
		await fetch(`http://127.0.0.1:${port}/json/list`)
	).json()) as { type: string; webSocketDebuggerUrl: string }[];
	const page = targets.find((t) => t.type === "page");
	if (!page) throw new Error("Chrome opened no page target");

	const ws = new WebSocket(page.webSocketDebuggerUrl);
	onSocket(ws);
	await new Promise((res, rej) => {
		ws.addEventListener("open", res, { once: true });
		ws.addEventListener("error", rej, { once: true });
	});
	let nextId = 0;
	const replies = new Map<number, (msg: CdpMessage) => void>();
	const listeners: ((msg: CdpMessage) => void)[] = [];
	ws.addEventListener("message", (e) => {
		const msg = JSON.parse(String(e.data)) as CdpMessage;
		const reply = msg.id === undefined ? undefined : replies.get(msg.id);
		if (reply && msg.id !== undefined) {
			replies.delete(msg.id);
			reply(msg);
		} else for (const l of listeners) l(msg);
	});
	const send = (method: string, params: object = {}) =>
		new Promise<Record<string, unknown>>((res, rej) => {
			const id = ++nextId;
			replies.set(id, (msg) =>
				msg.error
					? rej(new Error(`${method}: ${msg.error.message}`))
					: res(msg.result ?? {}),
			);
			ws.send(JSON.stringify({ id, method, params }));
		});
	const evaluate = async <T>(expression: string): Promise<T> => {
		const r = (await send("Runtime.evaluate", {
			expression,
			returnByValue: true,
		})) as { result?: { value?: T } };
		return r.result?.value as T;
	};

	await send("Page.enable");
	// New headless spends part of `--window-size` on window chrome; pin the
	// viewport itself so the image is exactly 1600x900.
	await send("Emulation.setDeviceMetricsOverride", {
		...OFFICER_VIEWPORT,
		deviceScaleFactor: 1,
		mobile: false,
	});
	const loaded = new Promise<void>((res) =>
		listeners.push((m) => {
			if (m.method === "Page.loadEventFired") res();
		}),
	);
	await send("Page.navigate", { url });
	await loaded;
	await new Promise((r) => setTimeout(r, SETTLE_MS));

	const problem = check(
		await evaluate<string>("document.documentElement.outerHTML"),
	);
	if (problem) throw new Error(problem);
	// The dev server's TanStack devtools badge is not part of the product.
	await evaluate(
		`document.head.insertAdjacentHTML("beforeend", "<style>[data-testid=tanstack_devtools]{display:none!important}</style>")`,
	);
	const frame = await evaluate<SectionFrame | null>(`(() => {
		const el = document.getElementById(${JSON.stringify(sectionId)});
		if (!el) return null;
		const r = el.getBoundingClientRect();
		const hit = document.elementFromPoint(r.left + 4, r.top + 4);
		return { top: r.top, viewportHeight: innerHeight, headingVisible: !!hit && el.contains(hit) };
	})()`);
	const framing = framingProblem(sectionId, frame);
	if (framing || !frame) throw new Error(framing ?? "no frame");

	const shot = (await send("Page.captureScreenshot", { format: "png" })) as {
		data: string;
	};
	writeFileSync(out, Buffer.from(shot.data, "base64"));
	return frame.top;
}

interface CdpMessage {
	id?: number;
	method?: string;
	result?: Record<string, unknown>;
	error?: { message: string };
}

async function main() {
	if (!isLocalBaseUrl(BASE_URL)) {
		fail(
			`BASE_URL ${BASE_URL} is not localhost or 127.0.0.1. This script signs in through the dev-only /api/dev-login and captures seed data; run it against a local \`ENABLE_DEV_LOGIN=1 bun run dev\` only.`,
		);
	}
	const chrome = findChrome();
	if (!chrome) {
		fail(
			"no Chrome found. Set CHROME_PATH to a headless Chrome (on macOS, a Playwright chrome-headless-shell), or install google-chrome / chromium.",
		);
	}

	const { slug, meetingId } = await findTarget();
	const base = `${BASE_URL}/club/${slug}/meeting/${meetingId}`;
	const shots = [
		{ url: `${base}/print`, out: join(OUT_DIR, "tour-agenda.png") },
		{ url: `${base}/present`, out: join(OUT_DIR, "tour-present.png") },
	];

	const clubId = await findClubId();
	await assertUpcomingMeetings(clubId);
	const { vpeEmail, vpmEmail } = await findOfficerEmails(clubId);
	const officerShots = [
		{
			email: vpeEmail,
			id: VPE_SECTION_ID,
			path: `/admin/vpe-dashboard#${VPE_SECTION_ID}`,
			check: checkVpeDom,
			out: join(OUT_DIR, "tour-vpe.png"),
		},
		{
			email: vpmEmail,
			id: VPM_SECTION_ID,
			path: `/admin/vp-membership#${VPM_SECTION_ID}`,
			check: checkVpmDom,
			out: join(OUT_DIR, "tour-vpm.png"),
		},
	];

	for (const s of shots) await assertServes(s.url);
	await assertDevLogin(vpeEmail);

	// DOM checks first, for every officer shot, so a failure writes nothing.
	// Every dev-login call issues a fresh single-use link, so the check run and
	// the screenshot run each get their own URL.
	for (const s of officerShots) {
		const url = devLoginUrl(BASE_URL, s.email, s.path);
		const problem = s.check(
			runChrome(chrome, url, OFFICER_WINDOW, "--dump-dom"),
		);
		if (problem) fail(`${s.path} as ${s.email}: ${problem}`);
	}

	for (const s of shots) capture(chrome, s.url, s.out);
	for (const s of officerShots) {
		await captureSection(
			chrome,
			devLoginUrl(BASE_URL, s.email, s.path),
			s.out,
			s.id,
			s.check,
		);
	}
	process.exit(0);
}

await main();
