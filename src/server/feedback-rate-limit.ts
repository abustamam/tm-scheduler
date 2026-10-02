/**
 * A small in-memory, process-local limiter for anonymous role feedback (#984).
 *
 * Keyed on the client address, but what it holds is a SALTED HASH of it, with
 * the salt drawn fresh per process: nothing here can be read back as an IP,
 * nothing is persisted, and nothing is logged. A restart forgets everything,
 * which is fine — this is a speed bump in front of the club write lock, not the
 * cap. The caps (20 per recipient, 300 per meeting) are enforced under the lock
 * in `role-feedback-logic.ts` and do not depend on this.
 *
 * Fixed window per key. The map is swept of expired entries as it is used and
 * hard-bounded at `maxKeys`, so a flood of distinct addresses cannot grow it
 * without limit (past the bound the oldest entries are dropped, which errs on
 * the side of admitting).
 */
import { createHash, randomBytes } from "node:crypto";
import { FEEDBACK_PER_MEETING_CAP } from "#/lib/feedback-window";

export interface IpLimiter {
	/** True if this address may proceed now; counts the attempt when it may. */
	take(ip: string, now?: number): boolean;
	/** Test hook: how many addresses are tracked. */
	size(): number;
}

export function createIpLimiter(opts: {
	limit: number;
	windowMs: number;
	maxKeys?: number;
}): IpLimiter {
	const salt = randomBytes(16);
	const maxKeys = opts.maxKeys ?? 10_000;
	const buckets = new Map<string, { count: number; resetAt: number }>();
	const keyOf = (ip: string) =>
		createHash("sha256").update(salt).update(ip).digest("base64url");

	function sweep(now: number) {
		for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
		// Map iteration is insertion order, so the first keys are the oldest.
		while (buckets.size >= maxKeys) {
			const first = buckets.keys().next().value;
			if (first === undefined) break;
			buckets.delete(first);
		}
	}

	return {
		take(ip, now = Date.now()) {
			const key = keyOf(ip);
			const b = buckets.get(key);
			if (!b || b.resetAt <= now) {
				if (!b) sweep(now);
				buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
				return true;
			}
			if (b.count >= opts.limit) return false;
			b.count++;
			return true;
		},
		size: () => buckets.size,
	};
}

/** Notes one address may send per minute. Set by the maintainer at 60, not
 *  lower: a whole room on the venue's Wi-Fi shares ONE public address and
 *  sends its notes together when the meeting ends, so a small number would
 *  throttle real members. What this still stops is a script sending hundreds;
 *  the per-recipient and per-meeting caps are the real bound. */
export const FEEDBACK_IP_LIMIT = 60;
export const FEEDBACK_IP_WINDOW_MS = 60_000;

/** The process's one limiter for `leaveFeedback`. */
export const feedbackIpLimiter = createIpLimiter({
	limit: FEEDBACK_IP_LIMIT,
	windowMs: FEEDBACK_IP_WINDOW_MS,
});

/**
 * A per-address, PER-MEETING note budget (#1038), beside the per-minute
 * limiter above and kept the same way: process-local, keyed on a salted hash
 * (of the meeting id AND the address, so one meeting's key says nothing about
 * another's), never persisted, never logged. A restart forgets it.
 *
 * Unlike the per-minute limiter this is a reservation: `take` holds a slot
 * for an attempt and `release` gives it back when the attempt did not end in
 * a stored note, so only notes actually written spend the budget.
 *
 * An entry lives until `expiresAt` — the caller passes the meeting's
 * feedback-window close, after which no note to it is admitted anyway — and
 * the map is swept of expired entries as it is used and hard-bounded at
 * `maxKeys` (past the bound the oldest entries are dropped, which errs on the
 * side of admitting, like the limiter above).
 */
export interface SenderMeetingCap {
	/** True if this address may send another note to this meeting; reserves
	 *  one of its slots when it may. */
	take(ip: string, meetingId: string, expiresAt: number, now?: number): boolean;
	/** Give back a slot `take` reserved, for an attempt that stored nothing. */
	release(ip: string, meetingId: string): void;
	/** Test hook: how many (address, meeting) pairs are tracked. */
	size(): number;
}

export function createSenderMeetingCap(opts: {
	cap: number;
	maxKeys?: number;
}): SenderMeetingCap {
	const salt = randomBytes(16);
	const maxKeys = opts.maxKeys ?? 10_000;
	const entries = new Map<string, { count: number; expiresAt: number }>();
	// The meeting id is lowercased: the write path accepts either case and
	// Postgres resolves both to one meeting, so a case-sensitive key would
	// give one address a second budget for the same meeting.
	const keyOf = (ip: string, meetingId: string) =>
		createHash("sha256")
			.update(salt)
			.update(meetingId.toLowerCase())
			.update("\u0000")
			.update(ip)
			.digest("base64url");

	function sweep(now: number) {
		for (const [k, e] of entries) if (e.expiresAt <= now) entries.delete(k);
		while (entries.size >= maxKeys) {
			const first = entries.keys().next().value;
			if (first === undefined) break;
			entries.delete(first);
		}
	}

	return {
		take(ip, meetingId, expiresAt, now = Date.now()) {
			const key = keyOf(ip, meetingId);
			const e = entries.get(key);
			if (!e || e.expiresAt <= now) {
				if (e) entries.delete(key);
				sweep(now);
				if (expiresAt <= now) return true;
				entries.set(key, { count: 1, expiresAt });
				return true;
			}
			if (e.count >= opts.cap) return false;
			e.count++;
			return true;
		},
		release(ip, meetingId) {
			const key = keyOf(ip, meetingId);
			const e = entries.get(key);
			if (!e) return;
			e.count--;
			if (e.count <= 0) entries.delete(key);
		},
		size: () => entries.size,
	};
}

/** Notes one address may send to ONE meeting, over its whole feedback window:
 *  half of `FEEDBACK_PER_MEETING_CAP`, so no single sender can fill a meeting
 *  and leave every real member's note refused (#1038). Not lower, for the
 *  reason beside `FEEDBACK_IP_LIMIT`: a whole room on the venue's Wi-Fi shares
 *  ONE public address, and a room of twenty sending a few notes each must
 *  still fit. The per-recipient and per-meeting caps under the club lock stay
 *  the real bound; this only keeps one address from reaching the second. */
export const FEEDBACK_PER_ADDRESS_PER_MEETING_CAP =
	FEEDBACK_PER_MEETING_CAP / 2;

/** The process's one per-meeting budget for `leaveFeedback`. */
export const feedbackSenderMeetingCap = createSenderMeetingCap({
	cap: FEEDBACK_PER_ADDRESS_PER_MEETING_CAP,
});
