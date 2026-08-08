import { Link } from "@tanstack/react-router";
import { ArrowRight, HandHeart } from "lucide-react";

/**
 * "Planning a visit?" — the call-to-action a guest-facing club page was missing
 * (#319).
 *
 * The funnel it feeds already existed end to end: `/club/$clubId/guest-book`
 * (#208 / #239) captures a guest, `captureGuestVisit` records a visit against
 * the club's nearest meeting, and the guest lands at `stage: prospect` in the
 * VP-Membership pipeline. What it lacked was a door. Before this, the ONLY
 * reference to the guest-book URL anywhere in the app was
 * `_authed/admin/vp-membership.tsx`, where an officer derives it for a printed
 * QR code — so the entrance was reachable only by someone already standing in
 * the room.
 *
 * This is warm-lead capture, not acquisition. Every `/club/$clubId/*` route is
 * `noindex, nofollow` via the club shell, so nobody arrives here from a search
 * engine — a visitor reading this already has the link from a member. The CTA's
 * job is to convert someone who is already curious, which is why it points at
 * the guest book rather than at a contact form.
 *
 * Hidden from anyone who already belongs here. The prop is `hasIdentity`, NOT
 * "is signed in": this product's dominant path is the no-auth roster model,
 * where a member identifies by picking their name and is held in localStorage
 * (`useEffectiveMember`, #317). Gating on the signed-in `shell` alone showed
 * "Planning a visit? Guests are always welcome" to a member who had just
 * self-identified, on their own club's sign-up sheet.
 *
 * The gate lives HERE rather than in the route's JSX so the branch is
 * unit-testable — same reason `AboutClub` owns its own all-unset check.
 */
export function VisitCta({
	clubId,
	clubName,
	hasIdentity,
}: {
	clubId: string;
	clubName: string;
	/** True when the viewer already belongs to this club — either a signed-in
	 *  member (`shell`) or an anonymous visitor who picked their name. */
	hasIdentity: boolean;
}) {
	if (hasIdentity) return null;

	return (
		<section className="rounded-xl border border-[var(--line)] bg-card p-4">
			<div className="flex items-start gap-3">
				<HandHeart
					className="mt-0.5 size-4 shrink-0 text-[var(--lagoon-deep)]"
					aria-hidden
				/>
				<div className="min-w-0 flex-1">
					<h2 className="text-sm font-semibold text-foreground">
						Planning a visit?
					</h2>
					<p className="mt-1 text-sm text-muted-foreground">
						Let {clubName} know you're coming and they'll look out for you.
						Guests are always welcome.
					</p>
					<Link
						to="/club/$clubId/guest-book"
						params={{ clubId }}
						className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-primary no-underline hover:underline"
					>
						Sign the guest book
						<ArrowRight className="size-3.5" aria-hidden />
					</Link>
				</div>
			</div>
		</section>
	);
}
