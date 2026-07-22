import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { initialsOf, toneFromSeed } from "#/lib/avatar";
import type { StoredMember } from "#/lib/member-identity";
import { officerPositionLabel } from "#/lib/officers";
import { addMember, listMembers } from "#/server/members";
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
}: {
	clubUuid: string;
	onPicked: (m: StoredMember) => void;
}) {
	const [query, setQuery] = useState("");
	const [newName, setNewName] = useState("");

	const { data: members = [] } = useQuery({
		queryKey: ["members", clubUuid],
		queryFn: () => listMembers({ data: clubUuid }),
	});

	const addMutation = useMutation({
		mutationFn: (name: string) =>
			addMember({ data: { clubId: clubUuid, name } }),
	});

	const filtered = members.filter((m) =>
		m.name.toLowerCase().includes(query.trim().toLowerCase()),
	);

	async function handleAdd() {
		const name = newName.trim();
		if (!name || addMutation.isPending) return;
		try {
			const result = await addMutation.mutateAsync(name);
			onPicked({ id: result.id, name });
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Couldn't add you — try again.",
			);
		}
	}

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

			<div className="space-y-2 border-border border-t pt-4">
				<Label htmlFor="new-member-name">I'm new — add me</Label>
				<div className="flex gap-2">
					<Input
						id="new-member-name"
						placeholder="Your name"
						value={newName}
						onChange={(e) => setNewName(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								void handleAdd();
							}
						}}
						autoComplete="off"
					/>
					<Button
						type="button"
						onClick={() => void handleAdd()}
						disabled={!newName.trim() || addMutation.isPending}
					>
						Add me
					</Button>
				</div>
			</div>
		</div>
	);
}
