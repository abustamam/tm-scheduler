import type { PublicClubProfile } from "#/server/clubs-logic";
import { AboutClub } from "./about-club";
import { GuestResources } from "./guest-resources";
import { VisitCta } from "./visit-cta";

/**
 * Everything on the public club page that exists for someone who does NOT know
 * this club yet: what the club is and when it meets, what a Toastmasters
 * meeting is, and how to say you're coming (#318 / #319).
 *
 * The three used to be gated separately — in practice, only `VisitCta` was
 * gated at all — so a member who had just picked their own name off the roster
 * scrolled past "About this club" and "New to Toastmasters?" to reach the
 * sign-up sheet they came for. Measured at 390x844: the sheet started 693px
 * down with 151px of grid above the fold. Hiding this block for them moves it
 * to 447px and 397px of grid. The guest view is unchanged — for a guest this
 * content IS the page.
 *
 * `hasIdentity`, NOT "is signed in": this product's dominant path is the
 * no-auth roster model, where a member identifies by picking their name and is
 * held in localStorage (`useEffectiveMember`, #317). Gating on the signed-in
 * `shell` alone is the bug #319 shipped.
 *
 * One gate for the whole block rather than a copy in each component: three
 * conditionals that must agree is three chances for them to disagree. It lives
 * HERE rather than in the route's JSX so the branch stays unit-testable — see
 * the seventh coverage trap in CLAUDE.md.
 */
export function GuestOnboarding({
	hasIdentity,
	clubId,
	clubName,
	profile,
}: {
	/** True when the viewer already belongs to this club — either a signed-in
	 *  member (`shell`) or an anonymous visitor who picked their name. */
	hasIdentity: boolean;
	clubId: string;
	clubName: string;
	profile: PublicClubProfile | null;
}) {
	if (hasIdentity) return null;

	return (
		<>
			<AboutClub clubName={clubName} profile={profile} />
			<GuestResources clubId={clubId} />
			<VisitCta clubId={clubId} clubName={clubName} />
		</>
	);
}
