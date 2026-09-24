/**
 * DB-backed tests for the public request-access write path (#866):
 * `submitAccessRequestLogic`, the poller's `deliverAccessRequestMail`, and the
 * retention sweep, against real Postgres with the email transport injected.
 *
 * ## Isolation
 *
 * `access_requests` and `access_request_alerts` are club-less, so
 * `cleanup(clubId, …)` cannot reach them and vitest runs files in parallel
 * against one shared `tm_test`. Every email this suite uses ends in a per-run
 * domain (`@run-<uuid>.test`) and every alert window key starts with a per-run
 * prefix; the logic's test-only `scope` seam narrows every count, delivery and
 * sweep to those, and teardown deletes only rows under them.
 *
 * ## Why the caps are tested with small injected limits
 *
 * CLAUDE.md: never state a bound in terms of the number it constrains. So one
 * test pins `LIMITS` to its four literals — that is what a mutation of the
 * constant turns red — and every behaviour test passes its own small limits,
 * which is what a mutation of the COMPARISON turns red.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@127.0.0.1:5433/tm_test \
 *     bunx vitest run src/server/access-requests.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accessRequestAlerts, accessRequests } from "#/db/schema";
import { ACCESS_REQUEST_NOTIFY_EMAIL } from "#/lib/brand";
import type { SendEmailParams } from "#/lib/email";
import { hasTestDb, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

import {
	ACCESS_REQUEST_RETENTION_DAYS,
	type AccessRequestLimits,
	alertWindowKey,
	deliverAccessRequestMail,
	LIMITS,
	MAX_SENDS_PER_TICK,
	submitAccessRequestLogic,
	sweepExpiredAccessRequests,
} from "./access-requests-logic";
import {
	type AccessRequestFormInput,
	accessRequestSchema,
} from "./access-requests-schemas";
import {
	MAX_SEND_ATTEMPTS,
	type NotificationDeps,
	RETRY_BACKOFF_MS,
} from "./notifications-logic";

const RUN = randomUUID();
const RUN_DOMAIN = `run-${RUN}.test`;
const SCOPE = { emailLike: `%@${RUN_DOMAIN}`, alertKey: `test-${RUN}` };
const SMALL: AccessRequestLimits = {
	minFillMs: 3000,
	perEmail24h: 2,
	global24h: 3,
	notify24h: 1,
};
const DAY_MS = 24 * 60 * 60 * 1000;

let seq = 0;
/** An address no other test (or run) uses. */
const freshEmail = () => `person-${++seq}@${RUN_DOMAIN}`;

function form(
	overrides: Partial<AccessRequestFormInput> = {},
): AccessRequestFormInput {
	return {
		kind: "club",
		name: "Ada Lovelace",
		email: freshEmail(),
		clubName: "Analytical Speakers",
		fillMs: 10_000,
		trap: "",
		...overrides,
	};
}

/** Parse like the server fn's validator does, then run the logic. */
function submit(
	overrides: Partial<AccessRequestFormInput> = {},
	limits: AccessRequestLimits = SMALL,
) {
	return submitAccessRequestLogic(accessRequestSchema.parse(form(overrides)), {
		limits,
		scope: SCOPE,
	});
}

async function seedRows(
	n: number,
	fields: Partial<typeof accessRequests.$inferInsert> = {},
) {
	for (let i = 0; i < n; i++) {
		await testDb.insert(accessRequests).values({
			kind: "club",
			name: "Seeded",
			email: freshEmail(),
			clubName: "Seeded Club",
			...fields,
		});
	}
}

const runRows = () =>
	testDb
		.select()
		.from(accessRequests)
		.where(like(accessRequests.email, SCOPE.emailLike));

const runAlerts = () =>
	testDb
		.select()
		.from(accessRequestAlerts)
		.where(like(accessRequestAlerts.windowKey, `${SCOPE.alertKey}:%`));

/** Poller deps with a recording transport and a controllable clock. */
function makeDeps(now: () => Date = () => new Date()) {
	const sent: SendEmailParams[] = [];
	const sendEmail = vi.fn(async (p: SendEmailParams) => {
		sent.push(p);
	});
	return { deps: { sendEmail, now }, sent, sendEmail };
}

const deliver = (deps: NotificationDeps) =>
	deliverAccessRequestMail(deps, { scope: SCOPE });

/**
 * Run two delivery ticks with a barrier that forces the overlap rather than
 * hoping for it:
 *   A selects every due row, claims the first and blocks in its first send;
 *   B starts only then, selects the rest (A's first is inside its backoff),
 *   claims one and blocks in ITS send until A has finished;
 *   A resumes and walks the rest while B still holds its row unsent.
 * A claim that checks only "not yet sent" lets A take B's row again here; the
 * attempts-token claim is what refuses it. Returns every send, in order.
 */
async function overlappingTicks(): Promise<SendEmailParams[]> {
	const sends: SendEmailParams[] = [];
	let startB!: () => void;
	const bStarted = new Promise<void>((r) => {
		startB = r;
	});
	let bInSend!: () => void;
	const bSending = new Promise<void>((r) => {
		bInSend = r;
	});
	let aFinished!: () => void;
	const aDone = new Promise<void>((r) => {
		aFinished = r;
	});
	let aFirst = true;
	const depsA = {
		now: () => new Date(),
		sendEmail: async (p: SendEmailParams) => {
			sends.push(p);
			if (aFirst) {
				aFirst = false;
				startB();
				await bSending;
			}
		},
	};
	const depsB = {
		now: () => new Date(),
		sendEmail: async (p: SendEmailParams) => {
			sends.push(p);
			bInSend();
			await aDone;
		},
	};
	const tickA = deliver(depsA).then((r) => {
		aFinished();
		return r;
	});
	const tickB = bStarted.then(() => deliver(depsB));
	await Promise.all([tickA, tickB]);
	return sends;
}

describe("LIMITS", () => {
	it("pins the four production caps and the retention window as literals", () => {
		expect(LIMITS).toEqual({
			minFillMs: 3000,
			perEmail24h: 3,
			global24h: 200,
			notify24h: 40,
		});
		expect(ACCESS_REQUEST_RETENTION_DAYS).toBe(180);
		expect(MAX_SENDS_PER_TICK).toBe(5);
	});
});

describe("accessRequestSchema", () => {
	it("rejects a club request with no club name, and a district one with no number", () => {
		expect(accessRequestSchema.safeParse(form({ clubName: "" })).success).toBe(
			false,
		);
		expect(
			accessRequestSchema.safeParse(
				form({ kind: "district", clubName: undefined }),
			).success,
		).toBe(false);
		expect(
			accessRequestSchema.safeParse(
				form({ kind: "district", clubName: undefined, districtNumber: "57" }),
			).success,
		).toBe(true);
	});

	it("keeps a valid ref, nulls an invalid one, and never rejects over it", () => {
		expect(accessRequestSchema.parse(form({ ref: "district-57" })).ref).toBe(
			"district-57",
		);
		expect(accessRequestSchema.parse(form({ ref: "Not A Ref!" })).ref).toBe(
			null,
		);
		expect(accessRequestSchema.parse(form({ ref: 42 })).ref).toBe(null);
	});

	it("reads a missing or garbage fillMs as 0, so it can only ever fail the fill check", () => {
		for (const fillMs of [undefined, -5, Number.NaN, "9999", null]) {
			expect(
				accessRequestSchema.parse(form({ fillMs })).fillMs,
				String(fillMs),
			).toBe(0);
		}
		expect(accessRequestSchema.parse(form({ fillMs: 4200 })).fillMs).toBe(4200);
	});
});

describe.skipIf(!hasTestDb)("submitAccessRequestLogic (#866)", () => {
	afterEach(async () => {
		await testDb
			.delete(accessRequests)
			.where(like(accessRequests.email, SCOPE.emailLike));
		await testDb
			.delete(accessRequestAlerts)
			.where(like(accessRequestAlerts.windowKey, `${SCOPE.alertKey}:%`));
	});

	it("saves one lowercased club row that claims a notification, and sends nothing inline", async () => {
		const email = `Mixed.Case-${randomUUID()}@${RUN_DOMAIN.toUpperCase()}`;
		const res = await submit({ email: `  ${email}  `, ref: "district-57" });

		expect(res).toEqual({ ok: true });
		const rows = await runRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			kind: "club",
			email: email.toLowerCase(),
			clubName: "Analytical Speakers",
			ref: "district-57",
			notified: true,
			notifySentAt: null,
			notifyAttempts: 0,
		});
	});

	it("drops the other kind's fields", async () => {
		await submit({
			kind: "district",
			districtNumber: "57",
			clubName: "should not be stored",
		});
		const [row] = await runRows();
		expect(row).toMatchObject({
			kind: "district",
			districtNumber: "57",
			clubName: null,
		});
	});

	it("answers a filled honeypot, or a too-fast fill, with a silent ok and no write", async () => {
		expect(await submit({ trap: "https://spam.example" })).toEqual({
			ok: true,
		});
		expect(await submit({ fillMs: SMALL.minFillMs - 1 })).toEqual({
			ok: true,
		});
		expect(await submit({ fillMs: undefined })).toEqual({ ok: true });
		expect(await runRows()).toHaveLength(0);
		// A fill exactly at the floor is a person.
		expect(await submit({ fillMs: SMALL.minFillMs })).toEqual({ ok: true });
		expect(await runRows()).toHaveLength(1);
	});

	it("at the per-email cap, writes nothing, says it already has the request, and alerts", async () => {
		const email = freshEmail();
		// A row outside the window does not count toward the cap.
		await seedRows(1, {
			email,
			createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
		});
		await seedRows(SMALL.perEmail24h - 1, { email });

		// One under the cap: still accepted.
		expect(await submit({ email })).toEqual({ ok: true });
		expect(await runAlerts()).toHaveLength(0);
		// Now at the cap: refused, politely.
		expect(await submit({ email })).toEqual({
			ok: true,
			alreadyReceived: true,
		});
		expect(await runRows()).toHaveLength(SMALL.perEmail24h + 1);
		const [alert] = await runAlerts();
		expect(alert).toMatchObject({ reason: "per_email", trips: 1 });
	});

	it("at the global cap, writes nothing, answers busy, and alerts", async () => {
		await seedRows(SMALL.global24h);
		expect(await submit()).toEqual({ ok: false, reason: "busy" });
		expect(await runRows()).toHaveLength(SMALL.global24h);
		const [alert] = await runAlerts();
		expect(alert).toMatchObject({ reason: "global", trips: 1 });
	});

	it("at the notification cap, saves the row un-notified and alerts", async () => {
		await seedRows(SMALL.notify24h, { notified: true });
		const email = freshEmail();
		expect(await submit({ email })).toEqual({ ok: true });
		const saved = (await runRows()).filter((r) => r.email === email);
		expect(saved).toHaveLength(1);
		expect(saved[0]?.notified).toBe(false);
		const [alert] = await runAlerts();
		expect(alert).toMatchObject({ reason: "notify", trips: 1 });
	});

	it("records ONE alert per window per reason however many trips, counting them", async () => {
		await seedRows(SMALL.global24h);
		for (let i = 0; i < 4; i++) await submit();
		const alerts = await runAlerts();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toMatchObject({ reason: "global", trips: 4 });
		expect(alerts[0]?.windowKey).toBe(
			alertWindowKey(new Date(), "global", SCOPE),
		);
	});

	it("keys alerts by reason, so a benign per-email trip cannot silence a later flood", async () => {
		// Just after midnight: one address resubmits past its cap.
		const email = freshEmail();
		for (let i = 0; i <= SMALL.perEmail24h; i++) await submit({ email });
		// Later the same day: the form fills up.
		await seedRows(SMALL.global24h);
		await submit();
		const alerts = await runAlerts();
		// Both are there, each its own row, each unsent and so each still due.
		// (The second admission above also trips this suite's notify cap of 1.)
		expect(alerts.map((a) => a.reason)).toEqual(
			expect.arrayContaining(["per_email", "global"]),
		);
		expect(new Set(alerts.map((a) => a.windowKey)).size).toBe(alerts.length);
		expect(alerts.every((a) => a.sentAt === null)).toBe(true);
	});

	it("answers busy at once, writing nothing, when another submission holds the lock", async () => {
		// Hold the submission lock on a separate connection, as a stalled or
		// flooding holder would, and prove a submit does not wait behind it.
		const holder = await testDb.$client.connect();
		try {
			await holder.query("begin");
			await holder.query(
				"select pg_advisory_xact_lock(hashtextextended('access-requests:submit', 0))",
			);
			const started = Date.now();
			expect(await submit()).toEqual({ ok: false, reason: "busy" });
			expect(Date.now() - started).toBeLessThan(1000);
			expect(await runRows()).toHaveLength(0);
		} finally {
			await holder.query("rollback");
			holder.release();
		}
		// Released: the same submission now goes through.
		expect(await submit()).toEqual({ ok: true });
	});

	it("holds every cap under concurrency: parallel submits cannot overshoot", async () => {
		// The lock is TRIED, so a racer that finds it held answers busy rather
		// than waiting. Whatever mix of busy and admitted results a race gives,
		// what is WRITTEN must never exceed a cap. Without the lock each racer
		// counts the same zero rows and every one of them inserts.
		const email = freshEmail();
		const racers = 8;
		for (let round = 0; round < 3; round++) {
			const results = await Promise.all(
				Array.from({ length: racers }, () => submit({ email })),
			);
			const written = (await runRows()).length;
			expect(written).toBeLessThanOrEqual(SMALL.perEmail24h);
			// Every racer got an answer that matches what was written.
			const admitted = results.filter((r) => r.ok && !r.alreadyReceived);
			expect(admitted.length).toBe(written);
			await testDb
				.delete(accessRequests)
				.where(like(accessRequests.email, SCOPE.emailLike));
		}

		// Distinct emails racing for the day's one notification slot.
		for (let round = 0; round < 3; round++) {
			await Promise.all(
				Array.from({ length: racers }, () =>
					submit({}, { ...SMALL, global24h: 1000 }),
				),
			);
			const rows = await runRows();
			expect(rows.filter((r) => r.notified).length).toBeLessThanOrEqual(
				SMALL.notify24h,
			);
			await testDb
				.delete(accessRequests)
				.where(like(accessRequests.email, SCOPE.emailLike));
		}
	});
});

describe.skipIf(!hasTestDb)("deliverAccessRequestMail (#866)", () => {
	afterEach(async () => {
		await testDb
			.delete(accessRequests)
			.where(like(accessRequests.email, SCOPE.emailLike));
		await testDb
			.delete(accessRequestAlerts)
			.where(like(accessRequestAlerts.windowKey, `${SCOPE.alertKey}:%`));
	});

	it("emails the maintainer once per claimed row, reply-to the requester", async () => {
		const email = freshEmail();
		await submit({ email });
		const { deps, sent } = makeDeps();

		expect(await deliver(deps)).toMatchObject({ sent: 1, failed: 0 });
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			to: ACCESS_REQUEST_NOTIFY_EMAIL,
			replyTo: email,
			subject: "GavelUp access request: Analytical Speakers",
		});
		const [row] = await runRows();
		expect(row?.notifySentAt).not.toBeNull();

		// A second tick sends nothing more.
		expect(await deliver(deps)).toMatchObject({ sent: 0 });
		expect(sent).toHaveLength(1);
	});

	it("sends each row once when two poller ticks overlap", async () => {
		const roomy = { ...SMALL, global24h: 1000, notify24h: 10 };
		const emails = [freshEmail(), freshEmail(), freshEmail(), freshEmail()];
		for (const email of emails) {
			expect(await submit({ email }, roomy)).toEqual({ ok: true });
		}
		expect(await runAlerts()).toHaveLength(0);

		const sends = await overlappingTicks();

		const requestMail = sends.filter((m) =>
			m.subject.startsWith("GavelUp access request"),
		);
		expect(requestMail.map((m) => m.replyTo).sort()).toEqual(
			[...emails].sort(),
		);
		// And every row is marked sent exactly once.
		const rows = await runRows();
		expect(rows.every((r) => r.notifySentAt !== null)).toBe(true);
	});

	it("sends each alert once when two poller ticks overlap", async () => {
		const reasons = ["per_email", "global", "notify", "undelivered"] as const;
		await testDb.insert(accessRequestAlerts).values(
			reasons.map((reason) => ({
				windowKey: `${SCOPE.alertKey}:overlap:${reason}`,
				reason,
			})),
		);
		const sends = await overlappingTicks();
		const alertMail = sends.filter((m) => m.subject.includes("hit a limit"));
		expect(alertMail).toHaveLength(reasons.length);
		expect(new Set(alertMail.map((m) => m.idempotencyKey)).size).toBe(
			reasons.length,
		);
	});

	it("carries a stable idempotency key per row and per alert", async () => {
		await submit();
		const [row] = await runRows();
		await seedRows(SMALL.global24h);
		await submit();
		const [alert] = await runAlerts();
		const { deps, sent } = makeDeps();
		await deliver(deps);
		const keys = sent.map((m) => m.idempotencyKey);
		expect(keys).toContain(`access-request/${row?.id}`);
		expect(keys).toContain(`access-request-alert/${alert?.id}`);
	});

	it("stamps each claim with its own time, not the batch's start", async () => {
		const roomy = { ...SMALL, global24h: 1000, notify24h: 10 };
		await submit({}, roomy);
		await submit({}, roomy);
		let clock = Date.now();
		// Every call advances the clock a minute: a claim stamped from a single
		// batch-start value would give both rows the same time.
		const { deps } = makeDeps(() => {
			clock += 60_000;
			return new Date(clock);
		});
		await deliver(deps);
		const stamps = (await runRows()).map((r) =>
			r.notifyLastAttemptedAt?.getTime(),
		);
		expect(new Set(stamps).size).toBe(2);
	});

	it("sends at most MAX_SENDS_PER_TICK request emails per tick, oldest first", async () => {
		const roomy = { ...SMALL, global24h: 1000, notify24h: 100 };
		const total = MAX_SENDS_PER_TICK + 2;
		for (let i = 0; i < total; i++) await submit({}, roomy);
		const { deps, sent } = makeDeps();
		expect((await deliver(deps)).sent).toBe(MAX_SENDS_PER_TICK);
		expect((await deliver(deps)).sent).toBe(2);
		expect(sent).toHaveLength(total);
	});

	it("never emails a row that did not claim a notification slot", async () => {
		await seedRows(1, { notified: false });
		const { deps, sent } = makeDeps();
		await deliver(deps);
		expect(sent).toHaveLength(0);
	});

	it("retries a failed send after the backoff, and gives up at the attempt limit", async () => {
		await submit();
		let clock = Date.now();
		const { deps, sendEmail } = makeDeps(() => new Date(clock));
		sendEmail.mockRejectedValue(new Error("Resend down"));
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(await deliver(deps)).toMatchObject({ sent: 0, failed: 1 });
		let [row] = await runRows();
		expect(row).toMatchObject({
			notified: true,
			notifySentAt: null,
			notifyAttempts: 1,
			notifyLastError: "Resend down",
		});

		// Inside the backoff: not retried.
		expect(await deliver(deps)).toMatchObject({ failed: 0 });

		// Past it: retried, and this time it goes through.
		clock += RETRY_BACKOFF_MS + 1000;
		sendEmail.mockResolvedValue(undefined);
		expect(await deliver(deps)).toMatchObject({ sent: 1 });
		[row] = await runRows();
		expect(row?.notifySentAt).not.toBeNull();
		expect(row?.notifyLastError).toBeNull();

		// A row that has used every attempt is left alone.
		await seedRows(1, { notified: true, notifyAttempts: MAX_SEND_ATTEMPTS });
		sendEmail.mockClear();
		await deliver(deps);
		expect(sendEmail).not.toHaveBeenCalled();
		errSpy.mockRestore();
	});

	it("raises an undelivered alert when a request uses its last attempt", async () => {
		await seedRows(1, {
			notified: true,
			notifyAttempts: MAX_SEND_ATTEMPTS - 2,
		});
		let clock = Date.now();
		const { deps, sendEmail } = makeDeps(() => new Date(clock));
		sendEmail.mockRejectedValue(new Error("Resend down"));
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		// Second-to-last attempt fails: not yet undelivered.
		await deliver(deps);
		expect(await runAlerts()).toHaveLength(0);

		// Last attempt fails: one undelivered alert.
		clock += RETRY_BACKOFF_MS + 1000;
		await deliver(deps);
		const alerts = await runAlerts();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toMatchObject({ reason: "undelivered", trips: 1 });
		errSpy.mockRestore();
	});

	it("sends the window's cap alert once, with no requester data in it", async () => {
		await seedRows(SMALL.global24h);
		const secret = freshEmail();
		for (let i = 0; i < 3; i++) await submit({ email: secret });
		const { deps, sent } = makeDeps();

		const result = await deliver(deps);
		expect(result.alertsSent).toBe(1);
		const alertMail = sent.filter((m) => m.subject.includes("hit a limit"));
		expect(alertMail).toHaveLength(1);
		expect(alertMail[0]?.subject).toContain("(global)");
		expect(alertMail[0]?.text).toContain("Times so far this window: 3");
		expect(alertMail[0]?.text).not.toContain(secret);

		// More trips the same day do not send another.
		await submit();
		expect((await deliver(deps)).alertsSent).toBe(0);
	});

	it("escapes user values in the html body and strips newlines from the subject", async () => {
		await submit({
			name: "<b>x</b>",
			message: `"quoted" & <script>`,
			clubName: "Evil\r\nBcc: x@evil.test",
		});
		const { deps, sent } = makeDeps();
		await deliver(deps);
		const mail = sent[0];
		expect(mail?.subject).toBe("GavelUp access request: Evil Bcc: x@evil.test");
		expect(mail?.html).toContain("&lt;b&gt;x&lt;/b&gt;");
		expect(mail?.html).not.toContain("<b>x</b>");
		expect(mail?.html).not.toContain("<script>");
		expect(mail?.html).toContain("&quot;quoted&quot; &amp; &lt;script&gt;");
		// The text body is plain text: verbatim.
		expect(mail?.text).toContain("<b>x</b>");
	});
});

describe.skipIf(!hasTestDb)("sweepExpiredAccessRequests (#866)", () => {
	afterEach(async () => {
		await testDb
			.delete(accessRequests)
			.where(like(accessRequests.email, SCOPE.emailLike));
		await testDb
			.delete(accessRequestAlerts)
			.where(like(accessRequestAlerts.windowKey, `${SCOPE.alertKey}:%`));
	});

	it("deletes requests and alerts past the retention window, and nothing newer", async () => {
		const now = new Date();
		const old = new Date(
			now.getTime() - (ACCESS_REQUEST_RETENTION_DAYS * DAY_MS + 60_000),
		);
		const recent = new Date(
			now.getTime() - (ACCESS_REQUEST_RETENTION_DAYS * DAY_MS - 60_000),
		);
		await seedRows(2, { createdAt: old });
		await seedRows(1, { createdAt: recent });
		await testDb.insert(accessRequestAlerts).values([
			{
				windowKey: `${SCOPE.alertKey}:old`,
				reason: "global",
				createdAt: old,
			},
			{
				windowKey: `${SCOPE.alertKey}:new`,
				reason: "global",
				createdAt: recent,
			},
		]);

		expect(await sweepExpiredAccessRequests(now, SCOPE)).toEqual({
			requests: 2,
			alerts: 1,
		});
		expect(await runRows()).toHaveLength(1);
		expect((await runAlerts()).map((a) => a.windowKey)).toEqual([
			`${SCOPE.alertKey}:new`,
		]);
	});
});
