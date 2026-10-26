import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo } from "react";
import { PersonPicker } from "#/components/club/person-picker";
import { initialsOf, toneFromSeed } from "#/lib/avatar";
import type { StoredMember } from "#/lib/member-identity";
import { officerPositionLabel } from "#/lib/officers";
import { listMembers } from "#/server/members";
import { MemberAvatar } from "./member-avatar";

/**
 * Roster search and picker — search only, since #616/#630 removed the
 * "I'm new — add me" self-add (see `notListedHint` below). Extracted from the
 * retired `PickNameScreen` so the identity dialog reuses it. Router-independent:
 * `clubUuid` is passed in; on pick it calls `onPicked` with the member chosen
 * from the existing roster. Renders inside a Dialog (no full-page chrome of its
 * own).
 */
export function PickNameForm({
	clubUuid,
	onPicked,
	notListedHint,
}: {
	clubUuid: string;
	onPicked: (m: StoredMember) => void;
	/**
	 * What to offer someone who is not on the roster. Caller-supplied because the
	 * two surfaces need different answers: the club page has no other door and
	 * points at the guest book, while the ballot already renders its own
	 * "Visiting us today?" card below this form and would only duplicate it.
	 *
	 * There is deliberately no self-add here any more (#616). This form used to
	 * end in an "I'm new — add me" box wired to a session-less `addMember` server
	 * fn, so anyone holding the club link could write a row into the club's
	 * membership record — which is what put a tracked guest into a real club's
	 * roster. That fn no longer exists at all (#630).
	 */
	notListedHint?: ReactNode;
}) {
	const { data: members = [] } = useQuery({
		queryKey: ["members", clubUuid],
		queryFn: () => listMembers({ data: clubUuid }),
	});

	const people = useMemo(
		() =>
			members.map((m) => ({
				kind: "member" as const,
				id: m.id,
				name: m.name,
				preferredName: m.preferredName,
				officerPositions: m.officerPositions,
			})),
		[members],
	);

	return (
		<div className="flex flex-col gap-4">
			<PersonPicker
				people={people}
				inputLabel="Search members"
				placeholder="Type your name…"
				emptyText="No members match."
				onPick={(m) => onPicked({ id: m.id, name: m.name })}
				renderLeading={(m) => (
					<MemberAvatar
						tone={toneFromSeed(m.id)}
						initials={initialsOf(m.name)}
						size={38}
					/>
				)}
				renderMeta={(m) =>
					m.officerPositions.length ? (
						<span className="text-muted-foreground text-xs">
							{m.officerPositions.map(officerPositionLabel).join(", ")}
						</span>
					) : null
				}
			/>

			{notListedHint ? (
				<div className="space-y-2 border-border border-t pt-4 text-sm">
					{notListedHint}
				</div>
			) : null}
		</div>
	);
}
