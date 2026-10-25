/**
 * Presentation helpers for the GavelUp workspace.
 *
 * Member identity, speeches, speech logs, roles served, meeting agendas and now
 * join dates/tenure are wired to real data (see `src/server/club.ts`).
 *
 * Pathways progress (path / level / % / project) and member status have NO
 * database model yet — the fabricated mock that once lived here was removed. A
 * real, data-driven Pathways model is tracked in issue #61; `MemberStatus` /
 * `statusMeta` are kept as the vocabulary that work will reuse.
 */

export type MemberTone = "palm" | "lagoon" | "amber";
export type MemberStatus = "on" | "dtm" | "behind" | "new";

/** Avatar background gradient for a member "tone". */
export function avatarGradient(tone: MemberTone): string {
	switch (tone) {
		case "palm":
			return "linear-gradient(150deg, var(--color-success), #245238)";
		case "amber":
			return "linear-gradient(150deg, #e0b357, #c2851a)";
		default:
			return "linear-gradient(150deg, var(--color-highlight), var(--color-link))";
	}
}

export interface StatusMeta {
	/** CSS color for the status dot. */
	dot: string;
	label: string;
	/** Longer label used in the member-detail header. */
	longLabel: string;
}

export function statusMeta(status: MemberStatus): StatusMeta {
	switch (status) {
		case "on":
			return {
				dot: "var(--color-success)",
				label: "On track",
				longLabel: "On track",
			};
		case "dtm":
			return {
				dot: "var(--color-link)",
				label: "DTM track",
				longLabel: "DTM track",
			};
		case "behind":
			return {
				dot: "var(--color-warning)",
				label: "Behind",
				longLabel: "Behind on goals",
			};
		default:
			return {
				dot: "var(--color-muted-foreground)",
				label: "New member",
				longLabel: "New member",
			};
	}
}
