// Mail-delivery primitives for the poller's one remaining sender: the
// request-access form's mail to the maintainer (`deliverAccessRequestMail` in
// `access-requests-logic.ts`, #866). Moved here from the role-reminder
// delivery module when reminder emails were removed (#902, ADR-0028); the
// names are unchanged so the move is an import path only.
//
// Server-only and NOT a server-fn module: it imports the email transport, so
// only `*-logic.ts` modules and tests may import it.
import type { SendEmailParams } from "#/lib/email";
import { sendEmail as realSendEmail } from "#/lib/email";

/** Give up on a row after this many failed attempts (bounded retry). */
export const MAX_SEND_ATTEMPTS = 5;
/** A failed row waits at least this long before it's eligible to retry. Also
 *  keeps a just-claimed row out of the due set until the tick that claimed it
 *  finishes, so an overlapping tick can't pick it up mid-send. */
export const RETRY_BACKOFF_MS = 5 * 60_000;

/**
 * Side-effecting deps, injected so the access-request delivery pass is
 * testable with a mock transport and a fixed clock. Production wires the real
 * Resend/console transport via `defaultNotificationDeps`.
 */
export interface NotificationDeps {
	sendEmail(params: SendEmailParams): Promise<void>;
	/** Injectable clock — the tick's "now" for claiming and stamping. */
	now(): Date;
}

export const defaultNotificationDeps: NotificationDeps = {
	sendEmail: realSendEmail,
	now: () => new Date(),
};
