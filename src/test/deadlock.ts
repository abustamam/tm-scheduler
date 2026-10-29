/** Shared by the #1388 deadlock-retry tests. */

/** A driver-shaped deadlock-victim error (SQLSTATE 40P01). */
export const deadlock = () =>
	Object.assign(new Error("deadlock detected"), { code: "40P01" });

type TxCb = (tx: never) => Promise<unknown>;

/**
 * A `db.transaction` stand-in for `spy.mockImplementationOnce`: runs the real
 * body to its end on a real transaction, then fails it with a 40P01 so it
 * rolls back, as Postgres does to a victim. `afterRollback` runs once the
 * rollback has happened, before the error reaches the caller.
 */
export function failingTransaction(
	real: (cb: never) => Promise<unknown>,
	afterRollback?: () => Promise<void>,
) {
	return ((cb: TxCb) =>
		real((async (tx: never) => {
			await cb(tx);
			throw deadlock();
		}) as never).catch(async (e: unknown) => {
			await afterRollback?.();
			throw e;
		})) as never;
}
