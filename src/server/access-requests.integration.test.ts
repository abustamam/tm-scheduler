/**
 * DB-backed tests for the public request-access write path (#866):
 * `submitAccessRequestLogic` against real Postgres, with `sendEmail` mocked.
 *
 * ## Isolation
 *
 * `access_requests` is club-less, so `cleanup(clubId, …)` cannot reach it and
 * vitest runs files in parallel against one shared `tm_test`. Every email this
 * suite uses ends in a per-run domain (`@run-<uuid>.test`), the global and
 * notification counts are narrowed to that domain through the logic's
 * test-only `scope` seam, and teardown deletes only rows under that domain.
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accessRequests } from "#/db/schema";
import { ACCESS_REQUEST_NOTIFY_EMAIL } from "#/lib/brand";
import { hasTestDb, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));
vi.mock("#/lib/email", () => ({ sendEmail: vi.fn() }));

import { sendEmail } from "#/lib/email";
import {
	type AccessRequestLimits,
	LIMITS,
	submitAccessRequestLogic,
} from "./access-requests-logic";
import {
	type AccessRequestFormInput,
	accessRequestSchema,
} from "./access-requests-schemas";

const RUN_DOMAIN = `run-${randomUUID()}.test`;
const SCOPE = { emailLike: `%@${RUN_DOMAIN}` };
const SMALL: AccessRequestLimits = {
	minFillMs: 3000,
	perEmail24h: 2,
	global24h: 3,
	notify24h: 1,
};

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
		renderedAt: Date.now() - 10_000,
		website: "",
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

describe("LIMITS", () => {
	it("pins the four production caps as literals", () => {
		expect(LIMITS).toEqual({
			minFillMs: 3000,
			perEmail24h: 3,
			global24h: 200,
			notify24h: 40,
		});
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
});

describe.skipIf(!hasTestDb)("submitAccessRequestLogic (#866)", () => {
	beforeEach(() => {
		vi.mocked(sendEmail).mockReset();
		vi.mocked(sendEmail).mockResolvedValue(undefined);
	});

	afterEach(async () => {
		await testDb
			.delete(accessRequests)
			.where(like(accessRequests.email, SCOPE.emailLike));
	});

	it("saves one lowercased club row and emails the maintainer, reply-to the requester", async () => {
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
		});
		expect(sendEmail).toHaveBeenCalledTimes(1);
		expect(vi.mocked(sendEmail).mock.calls[0]?.[0]).toMatchObject({
			to: ACCESS_REQUEST_NOTIFY_EMAIL,
			replyTo: email.toLowerCase(),
			subject: "GavelUp access request: Analytical Speakers",
		});
	});

	it("drops the other kind's fields and titles a district request by number", async () => {
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
		expect(vi.mocked(sendEmail).mock.calls[0]?.[0].subject).toBe(
			"GavelUp district request: District 57",
		);
	});

	it("answers a filled honeypot, or a too-fast submission, with a silent ok", async () => {
		expect(await submit({ website: "https://spam.example" })).toEqual({
			ok: true,
		});
		expect(await submit({ renderedAt: Date.now() - 500 })).toEqual({
			ok: true,
		});
		expect(await runRows()).toHaveLength(0);
		expect(sendEmail).not.toHaveBeenCalled();
	});

	it("at the per-email cap, writes nothing and says it already has the request", async () => {
		const email = freshEmail();
		// A row outside the window does not count toward the cap.
		await seedRows(1, {
			email,
			createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
		});
		await seedRows(SMALL.perEmail24h - 1, { email });

		// One under the cap: still accepted.
		expect(await submit({ email })).toEqual({ ok: true });
		// Now at the cap: refused, politely.
		expect(await submit({ email })).toEqual({
			ok: true,
			alreadyReceived: true,
		});
		expect(await runRows()).toHaveLength(SMALL.perEmail24h + 1);
	});

	it("at the global cap, writes nothing and answers busy", async () => {
		await seedRows(SMALL.global24h);
		expect(await submit()).toEqual({ ok: false, reason: "busy" });
		expect(await runRows()).toHaveLength(SMALL.global24h);
		expect(sendEmail).not.toHaveBeenCalled();
	});

	it("at the notification cap, saves the row un-notified and sends nothing", async () => {
		await seedRows(SMALL.notify24h, { notified: true });
		const email = freshEmail();
		expect(await submit({ email })).toEqual({ ok: true });
		const saved = (await runRows()).filter((r) => r.email === email);
		expect(saved).toHaveLength(1);
		expect(saved[0]?.notified).toBe(false);
		expect(sendEmail).not.toHaveBeenCalled();
	});

	it("keeps the row, un-notified, when the send throws, and still answers ok", async () => {
		vi.mocked(sendEmail).mockRejectedValue(new Error("Resend down"));
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(await submit()).toEqual({ ok: true });
		const rows = await runRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.notified).toBe(false);
		expect(errSpy).toHaveBeenCalled();
		errSpy.mockRestore();
	});

	it("escapes user values in the html body", async () => {
		await submit({ name: "<b>x</b>", message: `"quoted" & <script>` });
		const { html, text } = vi.mocked(sendEmail).mock.calls[0]?.[0] ?? {
			html: "",
			text: "",
		};
		expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
		expect(html).not.toContain("<b>x</b>");
		expect(html).not.toContain("<script>");
		expect(html).toContain("&quot;quoted&quot; &amp; &lt;script&gt;");
		// The text body is plain text: verbatim.
		expect(text).toContain("<b>x</b>");
	});
});
