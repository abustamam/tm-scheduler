// The route hydration gate (#1000).
//
// Every SSR route, server-rendered by a real `vite dev` under UTC + en-US and
// hydrated by a real Chrome in America/Los_Angeles + es-ES, with BOTH clocks
// moved to 03:30 UTC on the 15th: one instant, two calendar days. Any
// React hydration error on a route fails it, named by route, source line and
// the two texts. `src/test/route-hydration.ts` is the harness and says what it
// cannot see.
//
// Why this exists beside `hydrateAcrossRuntimes`: that harness proves a
// component someone already suspected. #1000 was found by QA in production,
// on the page officers use most, because nothing loaded the routes.
//
// ## Coverage: every page route, or a named reason
//
// The route list is read off `routeTree.gen.ts`, not written here, and every
// full path must be in exactly one of `COVERED` (with the URL it is swept at)
// or `EXCLUDED` (with why). So a new page route fails this file until someone
// decides which it is.
//
// ## Known offenders
//
// #1000's brief: with more than five sites, land the gate with the known
// offenders listed and stop. `EXPECTED_MISMATCH` is that list. An entry there
// is still swept, and must STILL mismatch: fix one and this file tells you to
// delete its entry, so the list can only shrink.
//
// ## Needs
//
// A test database (`TEST_DATABASE_URL`, as every integration suite) and Chrome.
// Locally either missing skips; in CI either missing FAILS, the rule the other
// browser-backed suites follow, because a gate that silently skips reads
// exactly like one that passed.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	activityLog,
	clubs,
	duesPeriods,
	meetingAttendance,
	meetings,
	memberDues,
	members,
	officerTerms,
	people,
	roleDefinitions,
	roleSlots,
	session,
	user,
	verification,
} from "#/db/schema";
import {
	FEEDBACK_CLOSED_MESSAGE,
	FEEDBACK_NOT_OPEN_MESSAGE,
} from "#/lib/feedback-window";
import { ROLE_TEMPLATE } from "#/lib/role-template";
import { hasTestDb, testDb } from "#/test/db";
import { findChrome } from "#/test/print-page-count";
import {
	boundaryInstant,
	DEFAULT_CLIENT,
	type DevServer,
	describeMismatch,
	HydrationBrowser,
	REPO_ROOT,
	type RouteResult,
	startDevServer,
} from "#/test/route-hydration";

const inCI = Boolean(process.env.CI);
const hasChrome = findChrome() !== null;
const canRun = hasTestDb && hasChrome;

/**
 * `ROUTE_HYDRATION_ONLY=/admin/dues,/members/$id` sweeps just those full
 * paths, for iterating on one route locally. CI never sets it, and the run
 * REFUSES it there, so it cannot quietly narrow the gate.
 */
const ONLY = (process.env.ROUTE_HYDRATION_ONLY ?? "")
	.split(",")
	.filter(Boolean);

const ROUTE_TREE = join(REPO_ROOT, "src/routeTree.gen.ts");

/** Chromes sweeping at once. */
const BROWSERS = 3;

/** Every full path the router knows, read off the generated tree. */
function routerFullPaths(): string[] {
	const text = readFileSync(ROUTE_TREE, "utf8");
	const block = /fullPaths:\s*((?:\s*\|\s*'[^']*')+)/.exec(text)?.[1];
	if (!block) throw new Error("no `fullPaths:` union in routeTree.gen.ts");
	return [...block.matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
}

/** Ids the fixture creates, substituted into the COVERED urls. */
interface Fixture {
	run: string;
	clubId: string;
	slug: string;
	adminUserId: string;
	adminEmail: string;
	adminMemberId: string;
	personIds: string[];
	pastMeetingId: string;
	upcomingMeetingId: string;
	/** Started the evening before the shifted instant: its feedback is open. */
	feedbackMeetingId: string;
}

type Who = "signed-out" | "admin";

/**
 * Page routes and the URL each is swept at. `signed-out` routes are the
 * public ones a signed-in visitor is redirected away from (or that a visitor
 * reaches without an account); everything else is swept as a club admin who
 * is also a superadmin.
 */
const COVERED: Record<string, { who: Who; url: (f: Fixture) => string }> = {
	"/": { who: "signed-out", url: () => "/" },
	"/about": { who: "signed-out", url: () => "/about" },
	"/claim": { who: "signed-out", url: () => "/claim" },
	"/districts": { who: "signed-out", url: () => "/districts" },
	"/request-access": { who: "signed-out", url: () => "/request-access" },
	"/signin": { who: "signed-out", url: () => "/signin" },
	"/tour": { who: "signed-out", url: () => "/tour" },
	"/unsubscribe": { who: "signed-out", url: () => "/unsubscribe" },
	"/whats-new": { who: "signed-out", url: () => "/whats-new" },
	"/resources/": { who: "signed-out", url: () => "/resources" },
	"/resources/$slug": {
		who: "signed-out",
		url: () => "/resources/what-to-expect",
	},
	"/resources/evaluation-resources": {
		who: "signed-out",
		url: () => "/resources/evaluation-resources",
	},
	"/resources/which-path": {
		who: "signed-out",
		url: () => "/resources/which-path",
	},

	"/account": { who: "admin", url: () => "/account" },
	"/activity": { who: "admin", url: () => "/activity" },
	"/dashboard": { who: "admin", url: () => "/dashboard" },
	"/me": { who: "admin", url: () => "/me" },
	"/officers": { who: "admin", url: () => "/officers" },
	"/roster": { who: "admin", url: () => "/roster" },
	"/schedule": { who: "admin", url: () => "/schedule" },
	"/meetings/": { who: "admin", url: () => "/meetings" },
	"/members/$id": { who: "admin", url: (f) => `/members/${f.adminMemberId}` },
	"/superadmin/": { who: "admin", url: () => "/superadmin" },
	"/superadmin/$clubId": {
		who: "admin",
		url: (f) => `/superadmin/${f.clubId}`,
	},
	"/superadmin/duplicate-people": {
		who: "admin",
		url: () => "/superadmin/duplicate-people",
	},
	"/admin/action-items": { who: "admin", url: () => "/admin/action-items" },
	"/admin/agendas": { who: "admin", url: () => "/admin/agendas" },
	"/admin/charter": { who: "admin", url: () => "/admin/charter" },
	"/admin/club-settings": { who: "admin", url: () => "/admin/club-settings" },
	"/admin/dcp": { who: "admin", url: () => "/admin/dcp" },
	"/admin/dues": { who: "admin", url: () => "/admin/dues" },
	"/admin/pathways-sync": { who: "admin", url: () => "/admin/pathways-sync" },
	"/admin/roles": { who: "admin", url: () => "/admin/roles" },
	"/admin/schedule": { who: "admin", url: () => "/admin/schedule" },
	"/admin/sync-tokens": { who: "admin", url: () => "/admin/sync-tokens" },
	"/admin/vp-membership": { who: "admin", url: () => "/admin/vp-membership" },
	"/admin/vpe-dashboard": { who: "admin", url: () => "/admin/vpe-dashboard" },
	"/admin/meetings/batch": {
		who: "admin",
		url: () => "/admin/meetings/batch",
	},
	"/admin/meetings/new": { who: "admin", url: () => "/admin/meetings/new" },
	"/club/$clubId/": { who: "admin", url: (f) => `/club/${f.slug}` },
	"/club/$clubId/roles-guide": {
		who: "admin",
		url: (f) => `/club/${f.slug}/roles-guide`,
	},
	"/club/$clubId/guest-book": {
		who: "admin",
		url: (f) => `/club/${f.slug}/guest-book`,
	},
	"/club/$clubId/roles": { who: "admin", url: (f) => `/club/${f.slug}/roles` },
	"/club/$clubId/meeting/$meetingId": {
		who: "admin",
		url: (f) => `/club/${f.slug}/meeting/${f.pastMeetingId}`,
	},
	"/club/$clubId/meeting/$meetingId/agenda": {
		who: "admin",
		url: (f) => `/club/${f.slug}/meeting/${f.upcomingMeetingId}/agenda`,
	},
	"/club/$clubId/meeting/$meetingId/me": {
		who: "admin",
		url: (f) => `/club/${f.slug}/meeting/${f.upcomingMeetingId}/me`,
	},
	"/club/$clubId/meeting/$meetingId/flyer": {
		who: "admin",
		url: (f) => `/club/${f.slug}/meeting/${f.upcomingMeetingId}/flyer`,
	},
	"/club/$clubId/meeting/$meetingId/present": {
		who: "admin",
		url: (f) => `/club/${f.slug}/meeting/${f.pastMeetingId}/present`,
	},
	"/club/$clubId/meeting/$meetingId/print": {
		who: "admin",
		url: (f) => `/club/${f.slug}/meeting/${f.pastMeetingId}/print`,
	},
	"/club/$clubId/meeting/$meetingId/vote": {
		who: "admin",
		url: (f) => `/club/${f.slug}/meeting/${f.upcomingMeetingId}/vote`,
	},
	"/club/$clubId/meeting/$meetingId/word": {
		who: "admin",
		url: (f) => `/club/${f.slug}/meeting/${f.pastMeetingId}/word`,
	},
	// Public and session-less (#984), so swept signed out. Swept in its OPEN
	// state, the one with the role cards: the fixture's meeting started the
	// evening before the gate's instant, inside the window (start to scheduled
	// end + 3 days, `src/lib/feedback-window.ts`).
	"/club/$clubId/meeting/$meetingId/feedback": {
		who: "signed-out",
		url: (f) => `/club/${f.slug}/meeting/${f.feedbackMeetingId}/feedback`,
	},
	"/club/$clubId/meeting/$meetingId/me/theme": {
		who: "admin",
		url: (f) => `/club/${f.slug}/meeting/${f.upcomingMeetingId}/me/theme`,
	},
	"/club/$clubId/meeting/$meetingId/me/timer": {
		who: "admin",
		url: (f) => `/club/${f.slug}/meeting/${f.upcomingMeetingId}/me/timer`,
	},
	"/club/$clubId/meeting/$meetingId/me/topics": {
		who: "admin",
		url: (f) => `/club/${f.slug}/meeting/${f.upcomingMeetingId}/me/topics`,
	},
	"/club/$clubId/meeting/$meetingId/me/word": {
		who: "admin",
		url: (f) => `/club/${f.slug}/meeting/${f.upcomingMeetingId}/me/word`,
	},
};

/** Full paths deliberately not swept, each with the reason. */
const EXCLUDED: Record<string, string> = {
	"/superadmin":
		"layout route: renders only around a child, and its index /superadmin/ is swept",
	"/club/$clubId":
		"layout route: renders only around a child, and its index /club/$clubId/ is swept",
	"/.well-known/$": "JSON discovery documents, not a page",
	"/api/dev-login": "API route, no HTML",
	"/api/health": "API route, no HTML",
	"/api/mcp": "API route, no HTML",
	"/api/auth/$": "API route, no HTML",
	"/api/pathways/ingest": "API route, no HTML",
	"/api/club/$clubId/logo": "image endpoint, no HTML",
	"/api/clubs/$clubId/export/zip": "download endpoint, no HTML",
	"/api/meetings/$id/minutes/pdf": "PDF endpoint, no HTML",
	"/api/meetings/$id/packet/pdf": "PDF endpoint, no HTML",
	"/api/meetings/$id/role-sheets/$sheet/pdf": "PDF endpoint, no HTML",
	"/meetings/$id":
		"redirect only: answers with a redirect to /club/$clubId/meeting/$meetingId, which is swept",
	"/next":
		"redirect only: answers with a redirect to the next meeting's /club/$clubId/meeting/$meetingId, which is swept",
	"/oauth/consent":
		"renders only for a query the OAuth provider SIGNS; an unsigned one is refused before any page renders",
	"/agenda-plan/$planId":
		"needs a pending plan minted by the MCP connector (mcp_pending_plans), which this fixture does not create. Its two dates are runtime-zone KNOWN entries in format-locale.guard.test.ts",
	"/guest-book/$planId":
		"needs a pending plan minted by the MCP connector (mcp_pending_plans), which this fixture does not create. Its two dates are runtime-zone KNOWN entries in format-locale.guard.test.ts",
};

/**
 * Routes that hydrate with a mismatch TODAY, left for the maintainer to split
 * into issues (#1000's brief: more than five sites, so list them and stop).
 * Keyed by full path; the value is the site and the runtime input it reads.
 * Each is still swept and must still mismatch, so a fixed one fails this file
 * until its entry is deleted.
 */
/**
 * `stable: false` marks the one entry whose mismatch depends on the MACHINE
 * rather than the code: which ICU the server's Node and the browser each
 * ship. It is excused from the "still mismatches" check below, because it can
 * read clean on a runner whose two ICUs agree without anything being fixed.
 */
const EXPECTED_MISMATCH: Record<string, { why: string; stable?: false }> = {
	"/activity": {
		why: "activity.tsx dayKey / line 161: formatMeetingDate with no zone, so the day heading is the runtime's day",
	},
	"/members/$id": {
		why: "members.$id.tsx:341 speech-log badge: formatDayMonth(l.scheduledAt) with no zone, the runtime's day number",
	},
	"/superadmin/": {
		why: "superadmin/index.tsx module-level dateFmt: Intl.DateTimeFormat with no timeZone, the runtime's day",
	},
	"/superadmin/$clubId": {
		why: "superadmin/$clubId.tsx module-level dateFmt: Intl.DateTimeFormat with no timeZone, the runtime's day",
	},
	"/admin/club-settings": {
		why: "club-settings.tsx:646 zone option label: Intl shortOffset spells UTC+0 'GMT' in Node's ICU and 'GMT+0' in Chrome's. Not a zone or locale default; the static guard cannot see it",
		stable: false,
	},
	"/admin/dues": {
		why: "dues.tsx:481 paid date (and :265 due date): formatShortDate with no zone, the runtime's day",
	},
};

const CLUB_ZONE = "America/Chicago";
const DAY = 24 * 60 * 60 * 1000;

/**
 * A club in Chicago whose every meeting is at 02:00 UTC: the EVENING of the
 * previous day in the club's zone and the client's, so a date formatted in the
 * server's zone reads one day later than the club's.
 */
async function seedFixture(nowMs: number): Promise<Fixture> {
	const run = randomUUID().slice(0, 8);
	const slug = `route-hydration-${run}`;
	const adminUserId = randomUUID();
	const adminEmail = `route-hydration-${run}@test.example`;
	const today = new Date(nowMs);
	const at = (days: number) =>
		new Date(
			Date.UTC(
				today.getUTCFullYear(),
				today.getUTCMonth(),
				today.getUTCDate() + days,
				2,
				0,
			),
		);

	const [club] = await testDb
		.insert(clubs)
		.values({
			name: `Route Hydration ${run}`,
			slug,
			timezone: CLUB_ZONE,
			// On an evening too, not whenever the suite ran: the superadmin
			// console prints it.
			createdAt: at(-90),
		})
		.returning({ id: clubs.id });
	if (!club) throw new Error("club insert failed");

	await testDb.insert(user).values({
		id: adminUserId,
		name: "Ada Admin",
		email: adminEmail,
		emailVerified: true,
	});

	const roster = [
		{ key: "admin", name: "Ada Admin", email: adminEmail, userId: adminUserId },
		{ key: "speaker", name: "Sam Speaker", email: null, userId: null },
		{ key: "evaluator", name: "Eve Evaluator", email: null, userId: null },
		{ key: "overdue", name: "Olive Overdue", email: null, userId: null },
		{ key: "lapsed", name: "Lana Lapsed", email: null, userId: null },
	] as const;
	const personRows = await testDb
		.insert(people)
		.values(
			roster.map((r) => ({ name: r.name, email: r.email, userId: r.userId })),
		)
		.returning({ id: people.id });
	const memberRows = await testDb
		.insert(members)
		.values(
			roster.map((r, i) => ({
				clubId: club.id,
				personId: personRows[i]?.id as string,
				name: r.name,
				email: r.email,
				clubRole: r.key === "admin" ? ("admin" as const) : ("member" as const),
				status: "active" as const,
				joinedAt: new Date(nowMs - 400 * DAY),
			})),
		)
		.returning({ id: members.id });
	const member = Object.fromEntries(
		roster.map((r, i) => [r.key, memberRows[i]?.id as string]),
	) as Record<(typeof roster)[number]["key"], string>;

	await testDb.insert(officerTerms).values({
		membershipId: member.admin,
		position: "president",
		termStart: new Date(nowMs - 100 * DAY),
	});

	const defs = await testDb
		.insert(roleDefinitions)
		.values(ROLE_TEMPLATE.map((r) => ({ ...r, clubId: club.id })))
		.returning();
	const defId = (name: string) => {
		const d = defs.find((x) => x.name === name);
		if (!d) throw new Error(`no ${name} role in ROLE_TEMPLATE`);
		return d.id;
	};

	const meetingAt = async (days: number, status: "completed" | "scheduled") => {
		const [m] = await testDb
			.insert(meetings)
			.values({
				clubId: club.id,
				scheduledAt: at(days),
				status,
				theme: "Boundaries",
				wordOfTheDay: "Threshold",
			})
			.returning({ id: meetings.id });
		if (!m) throw new Error("meeting insert failed");
		return m.id;
	};

	// Olive's only role, 70 days back: overdue, with a last-role date.
	const long = await meetingAt(-70, "completed");
	await testDb.insert(roleSlots).values({
		meetingId: long,
		roleDefinitionId: defId("Timer"),
		assignedMemberId: member.overdue,
		status: "claimed",
	});

	// Four recent meetings. Lana was present at the first only: a three-meeting
	// absence streak with a last-seen date.
	const recent = [];
	for (const days of [-28, -21, -14, -7]) {
		recent.push(await meetingAt(days, "completed"));
	}
	for (const [i, meetingId] of recent.entries()) {
		await testDb.insert(meetingAttendance).values([
			{ meetingId, memberId: member.admin, status: "present" },
			{
				meetingId,
				memberId: member.lapsed,
				status: i === 0 ? ("present" as const) : ("absent" as const),
			},
		]);
	}

	// The last of them: Sam speaks, Eve evaluates him.
	const past = recent[3] as string;
	const [speech] = await testDb
		.insert(roleSlots)
		.values({
			meetingId: past,
			roleDefinitionId: defId("Speaker"),
			assignedMemberId: member.speaker,
			status: "claimed",
		})
		.returning({ id: roleSlots.id });
	await testDb.insert(roleSlots).values({
		meetingId: past,
		roleDefinitionId: defId("Evaluator"),
		assignedMemberId: member.evaluator,
		evaluatesSlotId: speech?.id,
		status: "claimed",
	});

	// A logged edit to that meeting, stamped the same evening: /activity
	// groups by day and prints the meeting's date and the entry's time.
	await testDb.insert(activityLog).values({
		clubId: club.id,
		actorMemberId: member.admin,
		action: "meeting_edit",
		targetType: "meeting",
		targetId: past,
		detail: { change: "theme" },
		createdAt: at(-7),
	});

	// Dues, due and paid on an evening: /admin/dues prints both days.
	const [period] = await testDb
		.insert(duesPeriods)
		.values({
			clubId: club.id,
			label: "Spring",
			dueDate: at(-30),
			defaultAmountCents: 4500,
		})
		.returning({ id: duesPeriods.id });
	await testDb.insert(memberDues).values({
		membershipId: member.admin,
		duesPeriodId: period?.id as string,
		status: "paid",
		amountCents: 4500,
		paidAt: at(-31),
	});

	// Last night's meeting, feedback window open at the gate's instant, with
	// one served role so the page has a card to render.
	const lastNight = await meetingAt(-1, "scheduled");
	await testDb.insert(roleSlots).values({
		meetingId: lastNight,
		roleDefinitionId: defId("Timer"),
		assignedMemberId: member.evaluator,
		status: "claimed",
	});

	const upcoming = await meetingAt(6, "scheduled");
	await testDb.insert(roleSlots).values({
		meetingId: upcoming,
		roleDefinitionId: defId("Speaker"),
		assignedMemberId: member.admin,
		status: "claimed",
	});

	return {
		run,
		clubId: club.id,
		slug,
		adminUserId,
		adminEmail,
		adminMemberId: member.admin,
		personIds: personRows.map((p) => p.id),
		pastMeetingId: past,
		upcomingMeetingId: upcoming,
		feedbackMeetingId: lastNight,
	};
}

async function cleanupFixture(f: Fixture) {
	// The club cascades members, meetings, slots, attendance, roles and terms.
	await testDb.delete(clubs).where(eq(clubs.id, f.clubId));
	await testDb.delete(people).where(inArray(people.id, f.personIds));
	// The user cascades its sessions and accounts.
	await testDb.delete(user).where(eq(user.id, f.adminUserId));
	// Magic-link tokens are keyed by token, not user; the email is in the value.
	await testDb
		.delete(verification)
		.where(like(verification.value, `%${f.adminEmail}%`));
}

describe("route hydration gate (#1000)", () => {
	it("runs in CI: a test database and Chrome are both present", () => {
		if (!inCI) return;
		expect(
			hasTestDb,
			"CI has no TEST_DATABASE_URL, so the gate would skip",
		).toBe(true);
		expect(hasChrome, "CI has no Chrome on PATH, so the gate would skip").toBe(
			true,
		);
	});

	it("classifies every router path exactly once", () => {
		const paths = routerFullPaths();
		expect(paths.length).toBeGreaterThan(50);
		const unclassified = paths.filter(
			(p) => !(p in COVERED) && !(p in EXCLUDED),
		);
		expect(
			unclassified,
			"a new route: add it to COVERED with a URL, or to EXCLUDED with why",
		).toEqual([]);
		expect(Object.keys(COVERED).filter((p) => p in EXCLUDED)).toEqual([]);
		expect(
			[...Object.keys(COVERED), ...Object.keys(EXCLUDED)].filter(
				(p) => !paths.includes(p),
			),
			"no longer a route: remove it",
		).toEqual([]);
		expect(
			Object.keys(EXPECTED_MISMATCH).filter((p) => !(p in COVERED)),
		).toEqual([]);
	});

	describe.skipIf(!canRun)("under a shifted runtime", () => {
		const instant = boundaryInstant();
		const offset = instant - Date.now();
		let fixture: Fixture;
		let server: DevServer | undefined;
		const browsers: HydrationBrowser[] = [];
		let routeTreeBefore: string;
		let clientRuntime: { timeZone: string; locale: string; now: number };
		let sessionCreatedAt: Date | null = null;
		const results = new Map<string, RouteResult>();

		beforeAll(async () => {
			fixture = await seedFixture(instant);
			// `vite dev` appends a type-only footer to this TRACKED file; put it
			// back so a local run leaves the tree as it found it.
			routeTreeBefore = readFileSync(ROUTE_TREE, "utf8");
			try {
				server = await startDevServer({
					databaseUrl: process.env.TEST_DATABASE_URL as string,
					clockOffsetMs: offset,
					env: { SUPERADMIN_EMAILS: fixture.adminEmail },
				});
				const { base } = server;

				if (inCI && ONLY.length) {
					throw new Error(
						"ROUTE_HYDRATION_ONLY narrows the gate; unset it in CI",
					);
				}
				const entries = Object.entries(COVERED).filter(
					([p]) => ONLY.length === 0 || ONLY.includes(p),
				);

				// BROWSERS Chromes, each taking every BROWSERS-th route: a warm load
				// is ~2s and nearly all of it is waiting, so they overlap well.
				// Sign-ins are serialised, because dev-login hands the magic link
				// over through a per-email slot two concurrent sign-ins would race.
				let signIns = Promise.resolve();
				const worker = async (index: number) => {
					const b = await HydrationBrowser.launch(DEFAULT_CLIENT, offset);
					browsers.push(b);
					const mine = entries.filter((_, i) => i % BROWSERS === index);
					for (const [fullPath, route] of mine) {
						if (route.who !== "signed-out") continue;
						results.set(fullPath, await b.sweep(base, route.url(fixture)));
					}
					const signedIn = signIns.then(() =>
						b.load(
							`${base}/api/dev-login?email=${encodeURIComponent(
								fixture.adminEmail,
							)}&redirect=/about`,
						),
					);
					signIns = signedIn.then(() => undefined);
					await signedIn;
					if (index === 0) clientRuntime = await b.runtime();
					for (const [fullPath, route] of mine) {
						if (route.who !== "admin") continue;
						results.set(fullPath, await b.sweep(base, route.url(fixture)));
					}
				};
				await Promise.all(
					Array.from({ length: BROWSERS }, (_, i) => worker(i)),
				);

				const [s] = await testDb
					.select({ createdAt: session.createdAt })
					.from(session)
					.where(eq(session.userId, fixture.adminUserId));
				sessionCreatedAt = s?.createdAt ?? null;
			} catch (err) {
				throw new Error(
					`${err instanceof Error ? err.message : String(err)}\n--- server log ---\n${server?.log().slice(-4000) ?? ""}`,
				);
			}
		}, 900_000);

		afterAll(async () => {
			await Promise.all(browsers.map((b) => b.close()));
			await server?.stop();
			if (readFileSync(ROUTE_TREE, "utf8") !== routeTreeBefore) {
				writeFileSync(ROUTE_TREE, routeTreeBefore);
			}
			if (fixture) await cleanupFixture(fixture);
		}, 60_000);

		it("shifted the browser's zone, locale and clock", () => {
			expect(clientRuntime.timeZone).toBe(DEFAULT_CLIENT.timeZone);
			expect(clientRuntime.locale).toBe(DEFAULT_CLIENT.locale);
			// Within the few minutes the sweep has taken so far.
			expect(Math.abs(clientRuntime.now - instant)).toBeLessThan(60 * 60_000);
		});

		it("shifted the SERVER's clock: the session it minted is stamped at the boundary", () => {
			expect(sessionCreatedAt).not.toBeNull();
			const stamped = (sessionCreatedAt as Date).getTime();
			expect(Math.abs(stamped - instant)).toBeLessThan(60 * 60_000);
		});

		it("rendered and hydrated every covered route where it was asked for", () => {
			const swept = [...results.values()];
			expect(swept.length).toBe(
				ONLY.length ? ONLY.length : Object.keys(COVERED).length,
			);
			expect(
				swept
					.filter((r) => r.landed !== r.path)
					.map((r) => `${r.path} -> ${r.landed}`),
				"redirected, so not swept: fix the URL or the fixture",
			).toEqual([]);
			expect(
				swept.filter((r) => !r.hydrated).map((r) => r.path),
				"React never attached, so a clean result would mean nothing",
			).toEqual([]);
		});

		it("rendered the fixture's club, not whatever database .env.local names", () => {
			// Every mismatch-free route above proves nothing if the server read
			// another database: this is the fixture's slug in the page it served.
			const club = results.get("/club/$clubId/");
			expect(club?.landed).toBe(`/club/${fixture.slug}`);
		});

		it("finished each route well inside its timeout", () => {
			// A route that sat out the full load deadline was probably never
			// judged "quiet", so its result is a guess: name it.
			expect(
				[...results.values()]
					.filter((r) => r.ms > 120_000)
					.map((r) => `${r.path}: ${r.ms}ms`),
			).toEqual([]);
		});

		it("swept /feedback in its OPEN state, the one with role cards", () => {
			const r = results.get("/club/$clubId/meeting/$meetingId/feedback");
			if (ONLY.length && !r) return;
			expect(r?.text).not.toContain(FEEDBACK_NOT_OPEN_MESSAGE);
			expect(r?.text).not.toContain(FEEDBACK_CLOSED_MESSAGE);
			// The one served role's holder, on a card.
			expect(r?.text).toContain("Eve Evaluator");
		});

		it("hydrates every route without a mismatch", () => {
			const found: string[] = [];
			for (const [fullPath, r] of results) {
				if (fullPath in EXPECTED_MISMATCH) continue;
				for (const m of r.mismatches) found.push(describeMismatch(r.path, m));
			}
			expect(found).toEqual([]);
		});

		it("every EXPECTED_MISMATCH still mismatches (the list only shrinks)", () => {
			const fixed = Object.entries(EXPECTED_MISMATCH)
				.filter(([, e]) => e.stable !== false)
				.map(([p]) => p)
				.filter((p) => ONLY.length === 0 || ONLY.includes(p))
				.filter((p) => (results.get(p)?.mismatches.length ?? 0) === 0);
			expect(fixed, "hydrates clean now: delete its entry").toEqual([]);
		});
	});
});
