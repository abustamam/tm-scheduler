/**
 * One place that turns a failed write into a toast (#761).
 *
 * Before this, every call site did `toast.error(err instanceof Error ? err.message
 * : "Couldn't do that.")`, which is fine for "the meeting is locked" and useless
 * for "you need to be signed in": the user is told what is wrong and given no
 * way to fix it, on a surface that is often reached from a shared link with no
 * sign-in control anywhere on screen.
 *
 * Three branches, and the third is deliberately byte-identical to what every
 * call site did before, so replacing a `toast.error` with this changes NOTHING
 * unless the error is one of the two write-proof refusals:
 *
 *  - {@link isSignInRequiredError} → the message plus a **"Sign in"** action
 *    that returns here afterwards.
 *  - {@link isNotOnRosterError} → the message and NO action. Offering "Sign in"
 *    to somebody who is already signed in is the worst available answer; the
 *    message itself names the fix (ask an officer to add your email).
 *  - anything else → today's behaviour, `fallback` for a non-`Error` throw.
 *
 * Lives under `src/components/` rather than `src/lib/` because it is a UI
 * effect: it imports `sonner` and touches `window`.
 */
import { toast } from "sonner";
import {
	isNotOnRosterError,
	isSignInRequiredError,
	signInHref,
} from "#/lib/write-proof";

/**
 * The current path, including its query string.
 *
 * Read INSIDE the click handler, never at module scope: this module is imported
 * by components that render during SSR, where `window` does not exist.
 */
function currentPath(): string {
	return `${window.location.pathname}${window.location.search}`;
}

/**
 * Report a failed write.
 *
 * @param fallback what to show when the throw was not an `Error` — keep each
 * call site's existing string, it is the only thing that carries the context.
 */
export function showWriteError(err: unknown, fallback: string): void {
	if (isSignInRequiredError(err)) {
		toast.error((err as Error).message, {
			action: {
				label: "Sign in",
				// A full navigation, not the router: sign-in ends in an email round
				// trip that comes back as a fresh document load anyway, and the
				// refusal already means this page's data is not what the user can act
				// on.
				onClick: () => window.location.assign(signInHref(currentPath())),
			},
		});
		return;
	}
	if (isNotOnRosterError(err)) {
		toast.error((err as Error).message);
		return;
	}
	toast.error(err instanceof Error ? err.message : fallback);
}
