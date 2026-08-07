/**
 * Header of the public club page (#542, F-005). The CLUB NAME is the H1 —
 * guests land here from shared links, and the club identity used to exist only
 * as 11px truncated caps in the shell header while the H1 said "Hi there 👋".
 * The greeting survives as a subline (without the emoji).
 *
 * Pure and router-free so it can be asserted directly (the route component
 * itself mounts a loader + server fns and can't render standalone in jsdom).
 */
export function ClubHomeHeader({
	clubName,
	memberName,
}: {
	clubName: string;
	memberName: string | null;
}) {
	return (
		<div className="pt-2">
			<h1 className="font-display text-2xl font-semibold tracking-tight">
				{clubName}
			</h1>
			<p className="mt-0.5 text-sm text-muted-foreground">
				Hi {memberName ?? "there"} — claim a role below, or check the ones you
				already hold.
			</p>
		</div>
	);
}
