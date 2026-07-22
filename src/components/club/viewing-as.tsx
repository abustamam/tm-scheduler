import type { StoredMember } from "#/lib/member-identity";

/**
 * Always-present identity control on the public club surfaces. Replaces
 * `SigningUpAs`. Guest state invites identifying (the discoverable entry point
 * for a TMOD/Grammarian, who hold slots and have nothing to *claim*);
 * identified state shows the name with a "not you?" switch. Both open the
 * name-pick dialog via `promptIdentity`.
 */
export function ViewingAs({
	member,
	promptIdentity,
}: {
	member: StoredMember | null;
	promptIdentity: () => void;
}) {
	if (!member) {
		return (
			<p className="text-sm text-muted-foreground">
				Viewing as guest
				<span aria-hidden> · </span>
				<button
					type="button"
					onClick={promptIdentity}
					className="font-medium text-foreground underline underline-offset-2 hover:text-foreground"
				>
					I'm a member →
				</button>
			</p>
		);
	}
	return (
		<p className="text-sm text-muted-foreground">
			Signing up as{" "}
			<span className="font-medium text-foreground">{member.name}</span>
			<span aria-hidden> · </span>
			<button
				type="button"
				onClick={promptIdentity}
				className="underline underline-offset-2 hover:text-foreground"
			>
				not you?
			</button>
		</p>
	);
}
