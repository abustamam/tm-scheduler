import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { initialsOf, toneFromSeed } from "#/lib/avatar";
import type { StoredMember } from "#/lib/member-identity";
import { officerPositionLabel } from "#/lib/officers";
import { listMembers } from "#/server/members";
import { MemberAvatar } from "./member-avatar";

/**
 * Roster search + "I'm new — add me" picker. Extracted from the retired
 * `PickNameScreen` so the identity dialog reuses it. Router-independent:
 * `clubUuid` is passed in; on pick it calls `onPicked` with the chosen/created
 * member. Renders inside a Dialog (no full-page chrome of its own).
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
	 * end in an "I'm new — add me" box wired to the session-less `addMember`, so
	 * anyone holding the club link could write a row into the club's membership
	 * record — which is what put a tracked guest into a real club's roster.
	 */
	notListedHint?: ReactNode;
}) {
	const [query, setQuery] = useState("");

	const { data: members = [] } = useQuery({
		queryKey: ["members", clubUuid],
		queryFn: () => listMembers({ data: clubUuid }),
	});

	const filtered = members.filter((m) =>
		m.name.toLowerCase().includes(query.trim().toLowerCase()),
	);

	return (
		<div className="flex flex-col gap-4">
			<div className="space-y-2">
				<Label htmlFor="member-search">Search members</Label>
				<Input
					id="member-search"
					type="search"
					placeholder="Type your name…"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					autoComplete="off"
				/>
			</div>

			<ul className="flex max-h-[40svh] flex-col gap-2 overflow-y-auto">
				{filtered.map((m) => (
					<li key={m.id}>
						<button
							type="button"
							onClick={() => onPicked({ id: m.id, name: m.name })}
							className="flex w-full items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent"
						>
							<MemberAvatar
								tone={toneFromSeed(m.id)}
								initials={initialsOf(m.name)}
								size={38}
							/>
							<span className="flex min-w-0 flex-col">
								<span className="truncate font-medium text-foreground">
									{m.name}
								</span>
								{m.officerPositions.length ? (
									<span className="truncate text-muted-foreground text-xs">
										{m.officerPositions.map(officerPositionLabel).join(", ")}
									</span>
								) : null}
							</span>
						</button>
					</li>
				))}
				{filtered.length === 0 ? (
					<li className="px-1 py-2 text-muted-foreground text-sm">
						No members match “{query}”.
					</li>
				) : null}
			</ul>

			{notListedHint ? (
				<div className="space-y-2 border-border border-t pt-4 text-sm">
					{notListedHint}
				</div>
			) : null}
		</div>
	);
}
