import { CLUB_BUSY_MESSAGE } from "./club-write-lock";
import { isDeadlock } from "./pg-errors";

/**
 * Run `fn` and, if Postgres chose it as a deadlock victim (40P01), run it ONCE
 * more. `fn` must be the WHOLE unit: its pre-transaction reads, its
 * `db.transaction`, and anything it assigns to outer state, so the second
 * attempt starts from nothing the aborted one produced. A second 40P01 throws
 * `CLUB_BUSY_MESSAGE` with the driver error as `cause`. Any other error
 * propagates at once, unretried (#1388).
 */
export async function withDeadlockRetry<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		if (!isDeadlock(err)) throw err;
	}
	try {
		return await fn();
	} catch (err) {
		if (isDeadlock(err)) throw new Error(CLUB_BUSY_MESSAGE, { cause: err });
		throw err;
	}
}
