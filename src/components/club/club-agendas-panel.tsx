import { Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { ADOPT_NOTICE, EDIT_THROUGH_MEETING } from "#/lib/club-agendas-copy";
import { formatMeetingDate } from "#/lib/format";
import {
	adoptStandardAgendaFn,
	type ClubAgendaSummary,
	type ClubAgendas,
	deleteClubTemplateFn,
	duplicateClubTemplateFn,
	type MeetingRef,
	renameClubTemplate,
	type SetDefaultResult,
	setClubDefaultTemplate,
	setClubTemplateEnabled,
} from "#/server/club-agendas";

/**
 * The Agendas page (#910): the club's own templates, which one is the default,
 * and — until the club has one — adopting the standard agenda.
 *
 * NO EDITOR (spec Q4 / D14). A template is edited through a meeting and saved
 * back with Save as club template (#909); the page says so in one line.
 *
 * Every action calls a server fn gated by `requireClubTemplateEditor` and then
 * `onChanged` so the route reloads what it shows. Nothing here is the rule:
 * disabling "Set as default" on a disabled template, say, is a convenience —
 * the server refuses it regardless.
 */
export function ClubAgendasPanel({
	clubId,
	agendas,
	onChanged,
}: {
	clubId: string;
	agendas: ClubAgendas;
	onChanged: () => Promise<void> | void;
}) {
	const [busy, setBusy] = useState<string | null>(null);
	const [confirmAdopt, setConfirmAdopt] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState<ClubAgendaSummary | null>(
		null,
	);
	const [renaming, setRenaming] = useState<ClubAgendaSummary | null>(null);
	const [result, setResult] = useState<SetDefaultResult | null>(null);

	/** Run one action, toast its failure, reload on success. */
	async function run(key: string, action: () => Promise<void>) {
		setBusy(key);
		try {
			await action();
			await onChanged();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusy(null);
		}
	}

	function adopt() {
		return run("adopt", async () => {
			const r = await adoptStandardAgendaFn({ data: { clubId } });
			setConfirmAdopt(false);
			setResult(r);
		});
	}

	function setDefault(templateId: string | null) {
		return run(`default:${templateId ?? "clear"}`, async () => {
			const r = await setClubDefaultTemplate({ data: { clubId, templateId } });
			if (templateId === null) {
				toast.success(
					"Default cleared. New meetings start on the standard agenda.",
				);
			} else {
				setResult(r);
			}
		});
	}

	return (
		<div className="space-y-6">
			<div className="space-y-1">
				<h1 className="font-display text-2xl font-semibold tracking-[-0.01em]">
					Agendas
				</h1>
				<p className="text-sm text-muted-foreground">
					{agendas.adopted
						? "New meetings start on a copy of your club's default agenda."
						: "New meetings start on the standard agenda."}
				</p>
				<p className="text-sm text-muted-foreground">{EDIT_THROUGH_MEETING}</p>
			</div>

			{agendas.adopted ? null : (
				<div className="rounded-lg border border-[var(--line)] p-4 space-y-2">
					<p className="text-sm">
						Make today's standard agenda your club's own. You can then change it
						from any meeting and save it back as your default.
					</p>
					<Button onClick={() => setConfirmAdopt(true)}>
						Adopt the standard agenda as our own
					</Button>
				</div>
			)}

			{agendas.templates.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					Your club has no agendas of its own yet.
				</p>
			) : (
				<ul className="space-y-3">
					{agendas.templates.map((t) => (
						<li
							key={t.id}
							className="rounded-lg border border-[var(--line)] p-4 space-y-3"
						>
							<div className="flex flex-wrap items-center gap-2">
								<span className="font-medium">{t.name}</span>
								{t.isDefault ? <Badge>Default</Badge> : null}
								{t.enabled ? null : <Badge variant="outline">Disabled</Badge>}
								<span className="text-xs text-muted-foreground">
									{t.beatCount} {t.beatCount === 1 ? "row" : "rows"}
								</span>
							</div>
							{t.description ? (
								<p className="text-sm text-muted-foreground">{t.description}</p>
							) : null}
							<div className="flex flex-wrap items-center gap-2">
								{t.isDefault ? (
									<Button
										variant="outline"
										size="sm"
										disabled={busy !== null}
										onClick={() => setDefault(null)}
									>
										Clear default
									</Button>
								) : (
									<Button
										size="sm"
										disabled={busy !== null || !t.enabled}
										onClick={() => setDefault(t.id)}
									>
										Set as default
									</Button>
								)}
								<Button
									variant="outline"
									size="sm"
									disabled={busy !== null}
									onClick={() => setRenaming(t)}
								>
									Rename
								</Button>
								<Button
									variant="outline"
									size="sm"
									disabled={busy !== null}
									onClick={() =>
										run(`dup:${t.id}`, async () => {
											await duplicateClubTemplateFn({
												data: { clubId, templateId: t.id },
											});
											toast.success(`Copied "${t.name}".`);
										})
									}
								>
									Duplicate
								</Button>
								<Button
									variant="outline"
									size="sm"
									disabled={busy !== null}
									onClick={() => setConfirmDelete(t)}
								>
									Delete
								</Button>
								<label className="flex items-center gap-2 text-sm">
									<input
										type="checkbox"
										checked={t.enabled}
										disabled={busy !== null}
										onChange={(e) =>
											run(`enabled:${t.id}`, async () => {
												await setClubTemplateEnabled({
													data: {
														clubId,
														templateId: t.id,
														enabled: e.target.checked,
													},
												});
											})
										}
									/>
									Enabled
								</label>
							</div>
						</li>
					))}
				</ul>
			)}

			<Dialog open={confirmAdopt} onOpenChange={setConfirmAdopt}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Adopt the standard agenda?</DialogTitle>
						<DialogDescription>{ADOPT_NOTICE}</DialogDescription>
					</DialogHeader>
					<p className="text-sm text-muted-foreground">
						It becomes your club's default: new meetings start on a copy of it,
						and upcoming meetings still on the standard agenda move to it.
					</p>
					<DialogFooter>
						<DialogClose asChild>
							<Button variant="outline">Cancel</Button>
						</DialogClose>
						<Button onClick={adopt} disabled={busy !== null}>
							{busy === "adopt" ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								"Adopt it"
							)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog
				open={confirmDelete !== null}
				onOpenChange={(open) => {
					if (!open) setConfirmDelete(null);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Delete "{confirmDelete?.name}"?</DialogTitle>
						<DialogDescription>
							Meetings that already use it keep their agenda.
							{confirmDelete?.isDefault
								? " It is your default, so new meetings will start on the standard agenda."
								: ""}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<DialogClose asChild>
							<Button variant="outline">Cancel</Button>
						</DialogClose>
						<Button
							variant="destructive"
							disabled={busy !== null}
							onClick={() => {
								const target = confirmDelete;
								if (!target) return;
								void run(`delete:${target.id}`, async () => {
									const r = await deleteClubTemplateFn({
										data: { clubId, templateId: target.id },
									});
									setConfirmDelete(null);
									toast.success(
										r.wasDefault
											? "Deleted. Your club is back on the standard agenda for new meetings."
											: "Deleted.",
									);
								});
							}}
						>
							Delete
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{renaming ? (
				<RenameDialog
					template={renaming}
					busy={busy !== null}
					onClose={() => setRenaming(null)}
					onSave={(name, description) =>
						run(`rename:${renaming.id}`, async () => {
							await renameClubTemplate({
								data: { clubId, templateId: renaming.id, name, description },
							});
							setRenaming(null);
						})
					}
				/>
			) : null}

			<Dialog
				open={result !== null}
				onOpenChange={(open) => {
					if (!open) setResult(null);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Your default agenda is set</DialogTitle>
						<DialogDescription>
							New meetings start on a copy of it. Here is what happened to your
							upcoming meetings.
						</DialogDescription>
					</DialogHeader>
					{result ? (
						<DefaultResultLists
							clubId={clubId}
							timezone={agendas.timezone}
							result={result}
						/>
					) : null}
					<DialogFooter>
						<DialogClose asChild>
							<Button>Done</Button>
						</DialogClose>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function RenameDialog({
	template,
	busy,
	onClose,
	onSave,
}: {
	template: ClubAgendaSummary;
	busy: boolean;
	onClose: () => void;
	onSave: (name: string, description: string | null) => void;
}) {
	const [name, setName] = useState(template.name);
	const [description, setDescription] = useState(template.description ?? "");
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Rename agenda</DialogTitle>
				</DialogHeader>
				<form
					className="space-y-3"
					onSubmit={(e) => {
						e.preventDefault();
						onSave(name, description.trim() === "" ? null : description);
					}}
				>
					<div className="space-y-1">
						<Label htmlFor="agenda-name">Name</Label>
						<Input
							id="agenda-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
						/>
					</div>
					<div className="space-y-1">
						<Label htmlFor="agenda-description">Description</Label>
						<Input
							id="agenda-description"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
						/>
					</div>
					<DialogFooter>
						<Button type="button" variant="outline" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" disabled={busy}>
							Save
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/**
 * What setting a default did, grouped the way the officer has to act on it:
 * nothing to do, nothing to do, apply it by hand, try again by hand. Every
 * meeting is linked, since the last two groups are finished from the meeting.
 */
export function DefaultResultLists({
	clubId,
	timezone,
	result,
}: {
	clubId: string;
	timezone: string;
	result: SetDefaultResult;
}) {
	const onCopy = result.keptEdited.filter((m) => m.onDefaultCopy);
	const edited = result.keptEdited.filter((m) => !m.onDefaultCopy);
	const total =
		result.applied.length +
		result.keptEdited.length +
		result.keptSignups.length +
		result.failed.length;
	if (total === 0) {
		return (
			<p className="text-sm text-muted-foreground">
				You have no upcoming meetings yet.
			</p>
		);
	}
	return (
		<div className="space-y-4 text-sm">
			<ResultGroup
				title="Now on your default agenda"
				meetings={result.applied}
				clubId={clubId}
				timezone={timezone}
			/>
			<ResultGroup
				title="Already on a copy of it"
				meetings={onCopy}
				clubId={clubId}
				timezone={timezone}
			/>
			<ResultGroup
				title="Kept its own edited agenda"
				meetings={edited}
				clubId={clubId}
				timezone={timezone}
			/>
			<ResultGroup
				title="Has sign-ups for roles the new default doesn't include; apply it from the meeting"
				meetings={result.keptSignups}
				clubId={clubId}
				timezone={timezone}
				note={(m) => m.roles.join(", ")}
			/>
			<ResultGroup
				title="Couldn't be changed. Try applying it from the meeting."
				meetings={result.failed}
				clubId={clubId}
				timezone={timezone}
			/>
		</div>
	);
}

function ResultGroup<T extends MeetingRef>({
	title,
	meetings,
	clubId,
	timezone,
	note,
}: {
	title: string;
	meetings: T[];
	clubId: string;
	timezone: string;
	note?: (m: T) => string | null;
}) {
	if (meetings.length === 0) return null;
	return (
		<section className="space-y-1">
			<h3 className="font-medium">{title}</h3>
			<ul className="space-y-1">
				{meetings.map((m) => {
					const extra = note?.(m);
					return (
						<li key={m.meetingId}>
							<Link
								to="/club/$clubId/meeting/$meetingId"
								params={{ clubId, meetingId: m.meetingId }}
								className="underline"
							>
								{formatMeetingDate(m.scheduledAt, timezone)}
							</Link>
							{extra ? (
								<span className="text-muted-foreground"> ({extra})</span>
							) : null}
						</li>
					);
				})}
			</ul>
		</section>
	);
}
