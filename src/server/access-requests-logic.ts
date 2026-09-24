// The public request-access form's write path (#866): bot filters, caps, the
// insert, and the maintainer's notification email.
//
// SESSION-LESS and anonymous, and it mints PII (a name and an email), so it sits
// in the same risk class as `captureGuestVisit`. There is no app-level rate
// limiter and no trusted client IP here (see the issue), so everything that
// bounds this path is below: a honeypot, a minimum fill time, a per-email cap,
// a global cap, and a separate cap on how many emails the maintainer receives.
//
// Imported only by `access-requests.ts` (a server-fn module) and tests, so
// `#/db` never reaches the client bundle.
import { and, count, eq, gt, like, type SQL } from "drizzle-orm";
import { db } from "#/db";
import { accessRequests } from "#/db/schema";
import { ACCESS_REQUEST_NOTIFY_EMAIL } from "#/lib/brand";
import { sendEmail } from "#/lib/email";
import type { AccessRequestInput } from "./access-requests-schemas";

export type AccessRequestLimits = {
	/** A form submitted sooner than this after it rendered is a bot. */
	minFillMs: number;
	/** At this many rows for one email in 24h, the next is "already received". */
	perEmail24h: number;
	/** At this many rows in 24h overall, the next is refused as "busy". */
	global24h: number;
	/** At this many notified rows in 24h, a new row is saved but not emailed. */
	notify24h: number;
};

/**
 * The production caps. `access-requests.integration.test.ts` pins these four
 * LITERALS in one test and drives the behaviour with small injected limits in
 * the rest, so a bound is never asserted in terms of the number it constrains.
 */
export const LIMITS: AccessRequestLimits = {
	minFillMs: 3000,
	perEmail24h: 3,
	global24h: 200,
	notify24h: 40,
};

const DAY_MS = 24 * 60 * 60 * 1000;

export type SubmitAccessRequestResult =
	| { ok: true; alreadyReceived?: true }
	| { ok: false; reason: "busy" };

export type SubmitAccessRequestOptions = {
	now?: Date;
	limits?: AccessRequestLimits;
	/**
	 * TEST-ONLY seam. Narrows the global and notification counts to rows whose
	 * email matches this LIKE pattern, so a suite that seeds rows under its own
	 * per-run domain is isolated from every other row in the shared `tm_test`.
	 * Production passes nothing, and the counts are then table-wide.
	 */
	scope?: { emailLike?: string };
};

/**
 * Handle one validated submission. The order is the contract:
 *
 * 1. honeypot filled → silent `{ ok: true }`, nothing written or sent;
 * 2. submitted faster than `minFillMs` after render → the same silence;
 * 3. per-email cap reached → `{ ok: true, alreadyReceived: true }`, no write;
 * 4. global cap reached → `{ ok: false, reason: "busy" }`, no write;
 * 5. insert the row (`notified = false`);
 * 6. under the notification cap, email the maintainer and mark it notified.
 *    A failed send is logged and leaves `notified = false`: the row is never
 *    lost, and the visitor still gets `{ ok: true }`.
 *
 * The caps are count-then-insert with no lock, so concurrent submissions can
 * overshoot each by the number in flight. At these volumes that is fine: they
 * exist to stop a flood, not to count exactly.
 */
export async function submitAccessRequestLogic(
	input: AccessRequestInput,
	{ now = new Date(), limits = LIMITS, scope }: SubmitAccessRequestOptions = {},
): Promise<SubmitAccessRequestResult> {
	// 1–2. Bots get exactly what a person gets, so neither filter is a signal.
	if (input.website !== "") return { ok: true };
	if (now.getTime() - input.renderedAt < limits.minFillMs) return { ok: true };

	const since = new Date(now.getTime() - DAY_MS);
	const inWindow = gt(accessRequests.createdAt, since);
	const scoped = (...conds: SQL[]): SQL | undefined =>
		and(
			inWindow,
			...conds,
			...(scope?.emailLike
				? [like(accessRequests.email, scope.emailLike)]
				: []),
		);

	// 3. Per-email cap. Email is already lowercased + trimmed by the schema.
	const [perEmail] = await db
		.select({ n: count() })
		.from(accessRequests)
		.where(and(inWindow, eq(accessRequests.email, input.email)));
	if ((perEmail?.n ?? 0) >= limits.perEmail24h) {
		return { ok: true, alreadyReceived: true };
	}

	// 4. Global cap.
	const [global] = await db
		.select({ n: count() })
		.from(accessRequests)
		.where(scoped());
	if ((global?.n ?? 0) >= limits.global24h) {
		return { ok: false, reason: "busy" };
	}

	// 5. Insert. Fields that belong to the other kind are dropped, so a row
	//    only ever carries what its own form asked for.
	const isClub = input.kind === "club";
	const [row] = await db
		.insert(accessRequests)
		.values({
			kind: input.kind,
			name: input.name,
			email: input.email,
			clubName: isClub ? (input.clubName ?? null) : null,
			clubNumber: isClub ? (input.clubNumber ?? null) : null,
			districtNumber: isClub ? null : (input.districtNumber ?? null),
			message: input.message ?? null,
			ref: input.ref,
		})
		.returning();
	if (!row) throw new Error("Couldn't save the request.");

	// 6. Notify, under its own cap. Everything past the insert is best-effort.
	try {
		const [notified] = await db
			.select({ n: count() })
			.from(accessRequests)
			.where(scoped(eq(accessRequests.notified, true)));
		if ((notified?.n ?? 0) < limits.notify24h) {
			const email = buildAccessRequestEmail(row);
			await sendEmail({
				to: ACCESS_REQUEST_NOTIFY_EMAIL,
				replyTo: row.email,
				...email,
			});
			await db
				.update(accessRequests)
				.set({ notified: true })
				.where(eq(accessRequests.id, row.id));
		}
	} catch (err) {
		// The id only: the row holds the PII, and the log need not repeat it.
		console.error(
			`[access-requests] notification failed for request ${row.id}:`,
			err,
		);
	}

	return { ok: true };
}

type AccessRequestRow = typeof accessRequests.$inferSelect;

/** Escape a value for an HTML text node or a double-quoted attribute. */
function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * The maintainer's notification. Every value came from an anonymous form, so
 * each one is escaped in the html body; the text body is plain text and needs
 * none.
 */
export function buildAccessRequestEmail(row: AccessRequestRow): {
	subject: string;
	html: string;
	text: string;
} {
	const subject =
		row.kind === "club"
			? `GavelUp access request: ${row.clubName ?? "(no club name)"}`
			: `GavelUp district request: District ${row.districtNumber ?? "?"}`;

	const fields: Array<[string, string | null]> = [
		["Kind", row.kind],
		["Name", row.name],
		["Email", row.email],
		...(row.kind === "club"
			? ([
					["Club name", row.clubName],
					["Club number", row.clubNumber],
				] as Array<[string, string | null]>)
			: ([["District", row.districtNumber]] as Array<[string, string | null]>)),
		["Message", row.message],
		["Ref", row.ref],
		["Received", row.createdAt.toISOString()],
	];

	const text = [
		subject,
		"",
		...fields.map(([label, value]) => `${label}: ${value ?? "(none)"}`),
		"",
		"Reply to this email to answer the requester directly.",
	].join("\n");

	const rows = fields
		.map(
			([label, value]) =>
				`<tr><th align="left" style="padding:4px 12px 4px 0;vertical-align:top;">${escapeHtml(label)}</th><td style="padding:4px 0;white-space:pre-wrap;">${value === null ? "<em>(none)</em>" : escapeHtml(value)}</td></tr>`,
		)
		.join("");
	const html = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /></head>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
    <h1 style="font-size:18px;">${escapeHtml(subject)}</h1>
    <table style="font-size:14px;border-collapse:collapse;">${rows}</table>
    <p style="font-size:13px;color:#52525b;">Reply to this email to answer the requester directly.</p>
  </body>
</html>`;

	return { subject, html, text };
}
