import { useCurrentMember } from "#/lib/member-identity";

/**
 * Identity line for the public meeting view: "Signing up as {name} · not you?"
 * (issue #220). Reads the club-scoped identity via {@link useCurrentMember} —
 * the same source the meeting viewer derives claim attribution from — so the
 * displayed name always matches who a Claim would go to. "not you?" clears the
 * stored identity through the shared store, which makes the club layout's
 * `RequireMember` gate re-render to the "Who are you?" screen in place — the
 * same semantics as the sign-up sheet's "not you?".
 *
 * Renders nothing when no identity is stored for this club (and on the server
 * / during hydration, where the store snapshot is null).
 */
export function SigningUpAs({ clubSlug }: { clubSlug: string }) {
	const { member, clearMember } = useCurrentMember(clubSlug);
	if (!member) return null;
	return (
		<p className="text-sm text-muted-foreground">
			Signing up as{" "}
			<span className="font-medium text-foreground">{member.name}</span>
			<span aria-hidden> · </span>
			<button
				type="button"
				onClick={clearMember}
				className="underline underline-offset-2 hover:text-foreground"
			>
				not you?
			</button>
		</p>
	);
}
