import { Loader2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import type {
	ConversionPlan,
	MeetingTemplateSummary,
} from "#/server/meeting-templates";

function errMessage(err: unknown) {
	return err instanceof Error ? err.message : "Something went wrong.";
}

/** "Ada Lovelace and Grace Hopper", "Ada, Grace and Alan". */
function joinNames(names: string[]): string {
	return new Intl.ListFormat("en", {
		style: "long",
		type: "conjunction",
	}).format(names);
}

type Choice = { id: string | null; name: string; description: string | null };

type Phase =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "loaded"; plan: ConversionPlan }
	| { kind: "failed"; message: string };

/**
 * "Change meeting type" — switches a meeting to a template, or back.
 *
 * The copy here IS the safety mechanism, not decoration. A released member
 * CANNOT be told by the app: `notifications.slot_id` is NOT NULL and ON DELETE
 * CASCADE to `role_slots`, so a notification enqueued against a slot the same
 * transaction deletes is destroyed before the poller sees it. This dialog is
 * therefore the only thing standing between two members and a wasted trip,
 * which is why it leads with their NAMES and an explicit instruction to message
 * them, rather than with a count.
 *
 * Friction scales with damage: Apply is one tap when nothing is claimed, and
 * takes a second confirm when real people lose a role. A confirm on every
 * change would just train officers to click through it.
 *
 * The server fns are passed IN rather than called here, so the whole component
 * is reachable from vitest without the Start runtime.
 */
export function MeetingTemplateDialog({
	open,
	onOpenChange,
	currentTemplateId,
	templates,
	loadPreview,
	onApply,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	currentTemplateId: string | null;
	templates: MeetingTemplateSummary[];
	loadPreview: (templateId: string | null) => Promise<ConversionPlan>;
	onApply: (templateId: string | null) => Promise<unknown>;
}) {
	const [selected, setSelected] = useState<string | null | undefined>(
		undefined,
	);
	const [phase, setPhase] = useState<Phase>({ kind: "idle" });
	const [confirming, setConfirming] = useState(false);
	const [pending, setPending] = useState(false);

	const choices: Choice[] = [
		{ id: null, name: "Standard meeting", description: null },
		...templates.map((t) => ({
			id: t.id,
			name: t.name,
			description: t.description,
		})),
	];

	async function choose(id: string | null) {
		setSelected(id);
		setConfirming(false);
		setPhase({ kind: "loading" });
		try {
			setPhase({ kind: "loaded", plan: await loadPreview(id) });
		} catch (err) {
			setPhase({ kind: "failed", message: errMessage(err) });
		}
	}

	async function apply() {
		if (pending || selected === undefined) return;
		setPending(true);
		try {
			await onApply(selected);
			onOpenChange(false);
		} catch (err) {
			setPhase({ kind: "failed", message: errMessage(err) });
		} finally {
			setPending(false);
		}
	}

	const plan = phase.kind === "loaded" ? phase.plan : null;
	const holders = plan?.releasedHolders ?? [];
	const destructive = holders.length > 0;
	const chosen = choices.find((c) => c.id === selected);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Change meeting type</DialogTitle>
				</DialogHeader>

				{templates.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						Only the standard meeting is set up for this club. Meeting templates
						are added by GavelUp — ask if you need one.
					</p>
				) : (
					<div className="flex flex-col gap-1">
						{choices.map((c) => (
							<button
								key={c.id ?? "standard"}
								type="button"
								onClick={() => choose(c.id)}
								aria-pressed={selected === c.id}
								className={`rounded-md border px-3 py-2 text-left text-sm ${
									selected === c.id ? "border-primary" : "border-transparent"
								} hover:bg-muted`}
							>
								<span className="flex items-center gap-2 font-medium">
									{c.name}
									{c.id === currentTemplateId ? (
										<span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
											Current
										</span>
									) : null}
								</span>
								{c.description ? (
									<span className="block text-muted-foreground text-xs">
										{c.description}
									</span>
								) : null}
							</button>
						))}
					</div>
				)}

				{phase.kind === "loading" ? (
					<p className="flex items-center gap-2 text-muted-foreground text-sm">
						<Loader2 className="size-4 animate-spin" aria-hidden="true" />
						Checking what this would change…
					</p>
				) : null}

				{phase.kind === "failed" ? (
					<div className="flex flex-col gap-2">
						<p className="text-destructive text-sm">
							Couldn't load what this change would do. {phase.message}
						</p>
						<div>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => choose(selected ?? null)}
							>
								Retry
							</Button>
						</div>
					</div>
				) : null}

				{plan ? (
					<div className="flex flex-col gap-2 text-sm">
						{destructive ? (
							<div className="flex gap-2">
								<TriangleAlert
									className="mt-0.5 size-4 shrink-0 text-destructive"
									aria-hidden="true"
								/>
								<div>
									<p className="font-medium">
										{joinNames(holders.map((h) => h.name))} will lose the{" "}
										{holders.length === 1 ? "role" : "roles"} they accepted.
									</p>
									<p className="text-muted-foreground">
										They won't be told automatically — message them after you
										switch.
									</p>
								</div>
							</div>
						) : (
							<p>
								No one has claimed a role yet. This adds {plan.slotsAdded}{" "}
								{plan.slotsAdded === 1 ? "role" : "roles"} and removes{" "}
								{plan.openSlotsRemoved} empty{" "}
								{plan.openSlotsRemoved === 1 ? "one" : "ones"}.
							</p>
						)}

						{destructive ? (
							<p className="text-muted-foreground text-xs">
								Also: removes {plan.openSlotsRemoved} unfilled{" "}
								{plan.openSlotsRemoved === 1 ? "role" : "roles"}, adds{" "}
								{plan.slotsAdded} {plan.slotsAdded === 1 ? "role" : "roles"}.
							</p>
						) : null}

						{plan.slotsWithSpeeches > 0 ? (
							<p className="text-muted-foreground text-xs">
								Speeches stay attached to their speakers.
							</p>
						) : null}

						{/* Names as plain text, never links: the unlayered `a` rule in
						    src/styles.css beats layered utilities and would repaint them
						    link-teal, which no className here could undo. */}
						{destructive ? (
							<ul className="max-h-40 overflow-y-auto text-muted-foreground text-xs">
								{holders.map((h) => (
									<li key={`${h.memberId ?? h.guestId}-${h.roleName}`}>
										{h.name} — {h.roleName}
									</li>
								))}
							</ul>
						) : null}
					</div>
				) : null}

				<DialogFooter className="gap-2">
					<DialogClose asChild>
						<Button type="button" variant="outline" disabled={pending}>
							Cancel
						</Button>
					</DialogClose>

					{confirming ? (
						<>
							<Button
								type="button"
								variant="outline"
								onClick={() => setConfirming(false)}
							>
								Go back
							</Button>
							<Button
								type="button"
								variant="destructive"
								disabled={pending}
								onClick={apply}
							>
								{pending ? (
									<Loader2 className="size-4 animate-spin" aria-hidden="true" />
								) : null}
								Yes, switch
							</Button>
						</>
					) : (
						<Button
							type="button"
							variant={destructive ? "destructive" : "default"}
							disabled={!plan || pending}
							onClick={() => {
								// Second confirm ONLY when real people lose a role.
								if (destructive) setConfirming(true);
								else apply();
							}}
						>
							{pending ? (
								<Loader2 className="size-4 animate-spin" aria-hidden="true" />
							) : null}
							{destructive
								? `Release ${holders.length} ${holders.length === 1 ? "role" : "roles"} and switch`
								: `Switch to ${chosen?.name ?? "this meeting type"}`}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
