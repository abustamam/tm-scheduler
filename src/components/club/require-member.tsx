import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { initialsOf, toneFromSeed } from "#/lib/avatar";
import { type StoredMember, useCurrentMember } from "#/lib/member-identity";
import { officerPositionLabel } from "#/lib/officers";
import { addMember, listMembers } from "#/server/members";
import { MemberAvatar } from "./member-avatar";

/**
 * Public gate for the member-mobile club shell. Reads the per-club identity
 * from localStorage (via {@link useCurrentMember}); until a member is picked it
 * shows the roster pick-name screen, then renders `children`.
 *
 * Router-independent on purpose — `clubUuid` and `clubSlug` are passed in by
 * the route layout, so this can be rendered (and tested) without a router.
 */
export function RequireMember({
	clubUuid,
	clubSlug,
	children,
}: {
	clubUuid: string;
	clubSlug: string;
	children: React.ReactNode;
}) {
	const { member, setMember } = useCurrentMember(clubSlug);
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);

	if (!mounted) {
		return (
			<output
				className="flex flex-1 items-center justify-center text-muted-foreground"
				aria-label="Loading"
			>
				<span aria-hidden>…</span>
			</output>
		);
	}

	if (!member) {
		return <PickNameScreen clubUuid={clubUuid} onPicked={setMember} />;
	}

	return <>{children}</>;
}

function PickNameScreen({
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
		<div className="flex flex-1 flex-col gap-6 px-5 py-8">
			<header className="space-y-1">
				<h1 className="font-display text-2xl font-semibold text-foreground">
					Who are you?
				</h1>
				<p className="text-muted-foreground text-sm">
					Pick your name to continue.
				</p>
			</header>

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

			<ul className="flex flex-col gap-2">
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

			<div className="mt-auto space-y-2 border-border border-t pt-6">
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
