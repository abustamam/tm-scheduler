/**
 * What the confirm says before a demo club rebuild (#1199, #1200). One string,
 * read by the superadmin console's card and by the in-club "Reset demo club"
 * card, so the two never disagree about what a rebuild deletes.
 */
export const REBUILD_CONFIRM =
	"Rebuilding deletes everything in the demo club, including people you added by hand, and builds it fresh. Their accounts are kept. Use @example.com addresses for anyone you add during a demo.";

/** What the roster says when an invite is not sent because the club is the demo
 *  club (#1200). */
export const DEMO_INVITE_NOT_SENT = "Demo club: invite not sent.";
