/**
 * Captures the two real screenshots `/tour` shows (#867):
 *
 *   public/landing/tour-agenda.png   ← /club/<slug>/meeting/<id>/print
 *   public/landing/tour-present.png  ← /club/<slug>/meeting/<id>/present
 *
 * Run: bun run marketing:screenshots
 *
 * PRECONDITIONS
 *   1. A local database seeded with `bun run db:seed`, reachable through
 *      `DATABASE_URL` in `.env.local` (Bun loads it). The images show only the
 *      seed's fictional club, Harbor City Speakers, and its fictional members.
 *      Never point this at a database holding a real club.
 *   2. `bun run dev` serving that same database on http://localhost:3000
 *      (override with `BASE_URL`).
 *   3. A headless Chrome, found the way the print gates find it:
 *      `findChrome()` from `src/test/print-page-count.ts` tries `$CHROME_PATH`,
 *      then the usual binary names. On macOS set `CHROME_PATH` (CLAUDE.md
 *      says which binary works and which one hangs).
 *
 * Exits non-zero, naming what is missing, when Chrome, the club or a
 * qualifying meeting is absent, when a page does not serve the club, or when a
 * capture comes out too small to be anything but a blank page.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHROME_ENV, findChrome } from "#/test/print-page-count";

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

function capture(chrome: string, url: string, out: string): void {
	// Remove any earlier capture first, so a Chrome that writes nothing cannot
	// pass the checks below on the previous run's file.
	rmSync(out, { force: true });
	const profile = mkdtempSync(join(tmpdir(), "marketing-shot-"));
	try {
		execFileSync(
			chrome,
			[
				"--headless",
				"--disable-gpu",
				"--no-sandbox",
				"--disable-extensions",
				`--user-data-dir=${profile}`,
				"--hide-scrollbars",
				"--window-size=1600,1000",
				// NOT `--virtual-time-budget=8000`, which #867 specified: against
				// `bun run dev` it never returns. Vite's HMR websocket stays open, so
				// virtual time never runs out, and Chrome sat there until the 40s
				// ceiling on every attempt. Without it Chrome shoots once the page
				// has loaded (~1s here, fonts included); `--timeout` is the
				// ceiling on that wait.
				"--timeout=8000",
				`--screenshot=${out}`,
				url,
			],
			{ env: CHROME_ENV, stdio: "pipe", timeout: 60_000 },
		);
	} catch (err) {
		fail(`Chrome failed on ${url}: ${(err as Error).message}`);
	} finally {
		rmSync(profile, { recursive: true, force: true });
	}
	if (!existsSync(out)) fail(`Chrome wrote no screenshot for ${url}.`);
	const bytes = statSync(out).size;
	if (bytes <= MIN_PNG_BYTES) {
		fail(
			`${out} is ${bytes} bytes, under ${MIN_PNG_BYTES}: that is a blank page, not an agenda.`,
		);
	}
	console.log(`wrote ${out} (${Math.round(bytes / 1024)} KB) from ${url}`);
}

async function main() {
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

	for (const s of shots) await assertServes(s.url);
	for (const s of shots) capture(chrome, s.url, s.out);
	process.exit(0);
}

await main();
