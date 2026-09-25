import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import {
	CLUB_TEMPLATE_DESCRIPTION_MAX,
	CLUB_TEMPLATE_NAME_MAX,
	parseClubTemplateFields,
} from "#/lib/club-template-key";

/** A club-owned template the officer may replace. */
export type ClubTemplateOption = { id: string; name: string };

/** What the dialog asks the server to do. The meeting is the caller's. */
export type SaveClubTemplateChoice =
	| { mode: "new"; name: string; description: string | null }
	| { mode: "replace"; templateId: string };

/** What an officer reads after a replace — the one thing a replace could
 *  make them worry about is the meetings already running the old version. */
export const REPLACE_SAVED_MESSAGE =
	"Saved. Meetings already using an earlier version keep their own copy.";

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : "Something went wrong.";
}

/**
 * "Save as club template" (#909): copy this meeting's CURRENT agenda into a
 * template the club owns, either as a new one or over one of its own.
 *
 * Presentational — the list and the save are props — so it is reachable from
 * vitest without the Start runtime, the same shape `MeetingTemplateDialog`
 * uses. `SaveClubTemplateButton` below is the wired form.
 *
 * There is no unsaved state to include: every agenda edit is persisted per
 * operation, so what is saved is the agenda as stored.
 */
export function SaveClubTemplateDialog({
	open,
	onOpenChange,
	clubTemplates,
	loadError,
	onSave,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The club's OWN templates, or null while they load. */
	clubTemplates: ClubTemplateOption[] | null;
	/** Why the list could not load, if it could not. Saving as new still works. */
	loadError?: string | null;
	onSave: (choice: SaveClubTemplateChoice) => Promise<unknown>;
}) {
	const [mode, setMode] = useState<"new" | "replace">("new");
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [templateId, setTemplateId] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [replaced, setReplaced] = useState(false);

	function reset() {
		setMode("new");
		setName("");
		setDescription("");
		setTemplateId("");
		setError(null);
		setPending(false);
		setReplaced(false);
	}

	function changeOpen(next: boolean) {
		if (!next) reset();
		onOpenChange(next);
	}

	/** The refusal the server would give — the same function, said before the
	 *  round-trip. */
	function validate(): SaveClubTemplateChoice | string {
		if (mode === "replace") {
			if (templateId === "") return "Choose the template to replace.";
			return { mode: "replace", templateId };
		}
		const parsed = parseClubTemplateFields(name, description);
		if ("error" in parsed) return parsed.error;
		return { mode: "new", ...parsed };
	}

	async function save() {
		if (pending) return;
		const choice = validate();
		if (typeof choice === "string") {
			setError(choice);
			return;
		}
		setError(null);
		setPending(true);
		try {
			await onSave(choice);
			if (choice.mode === "replace") {
				setReplaced(true);
			} else {
				toast.success(`Saved “${choice.name}” as a club template.`);
				changeOpen(false);
			}
		} catch (err) {
			setError(errMessage(err));
		} finally {
			setPending(false);
		}
	}

	const hasClubTemplates = (clubTemplates?.length ?? 0) > 0;

	return (
		<Dialog open={open} onOpenChange={changeOpen}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Save as club template</DialogTitle>
				</DialogHeader>

				{replaced ? (
					<>
						<p className="text-sm" data-testid="save-club-template-replaced">
							{REPLACE_SAVED_MESSAGE}
						</p>
						<DialogFooter>
							<Button type="button" onClick={() => changeOpen(false)}>
								Done
							</Button>
						</DialogFooter>
					</>
				) : (
					<>
						<p className="text-muted-foreground text-sm">
							Saves this agenda as it stands now, so your club can pick it for
							another meeting. No meeting's agenda changes.
						</p>

						<fieldset className="flex flex-col gap-2">
							<legend className="sr-only">How to save</legend>
							<label className="flex items-center gap-2 text-sm">
								<input
									type="radio"
									name="save-club-template-mode"
									value="new"
									checked={mode === "new"}
									onChange={() => {
										setMode("new");
										setError(null);
									}}
								/>
								Save as a new template
							</label>
							<label className="flex items-center gap-2 text-sm">
								<input
									type="radio"
									name="save-club-template-mode"
									value="replace"
									checked={mode === "replace"}
									disabled={!hasClubTemplates}
									onChange={() => {
										setMode("replace");
										setError(null);
									}}
								/>
								Replace one of your club's templates
							</label>
							{clubTemplates === null && !loadError ? (
								<p className="flex items-center gap-2 text-muted-foreground text-xs">
									<Loader2 className="size-3 animate-spin" aria-hidden="true" />
									Loading your club's templates…
								</p>
							) : null}
							{loadError ? (
								<p className="text-muted-foreground text-xs">
									Couldn't load your club's templates. {loadError}
								</p>
							) : null}
							{clubTemplates !== null && !hasClubTemplates ? (
								<p className="text-muted-foreground text-xs">
									Your club has no templates of its own yet.
								</p>
							) : null}
						</fieldset>

						{mode === "new" ? (
							<div className="flex flex-col gap-3">
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="save-club-template-name">Name</Label>
									<Input
										id="save-club-template-name"
										value={name}
										maxLength={CLUB_TEMPLATE_NAME_MAX * 2}
										onChange={(e) => setName(e.target.value)}
										placeholder="Contest night"
									/>
								</div>
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="save-club-template-description">
										Description (optional)
									</Label>
									<Textarea
										id="save-club-template-description"
										value={description}
										maxLength={CLUB_TEMPLATE_DESCRIPTION_MAX * 2}
										onChange={(e) => setDescription(e.target.value)}
									/>
								</div>
							</div>
						) : (
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="save-club-template-target">
									Template to replace
								</Label>
								<select
									id="save-club-template-target"
									className="h-9 w-full rounded-md border bg-background px-2 text-sm"
									value={templateId}
									onChange={(e) => {
										setTemplateId(e.target.value);
										setError(null);
									}}
								>
									<option value="">Choose a template</option>
									{(clubTemplates ?? []).map((t) => (
										<option key={t.id} value={t.id}>
											{t.name}
										</option>
									))}
								</select>
								<p className="text-muted-foreground text-xs">
									Its name stays. Meetings already using it keep the agenda they
									have.
								</p>
							</div>
						)}

						{error ? (
							<p className="text-destructive text-sm" role="alert">
								{error}
							</p>
						) : null}

						<DialogFooter className="gap-2">
							<Button
								type="button"
								variant="outline"
								onClick={() => changeOpen(false)}
							>
								Cancel
							</Button>
							<Button type="button" onClick={save} disabled={pending}>
								{pending ? (
									<Loader2 className="size-4 animate-spin" aria-hidden="true" />
								) : null}
								{mode === "replace" ? "Replace template" : "Save template"}
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

/**
 * The wired form: a toolbar button that opens the dialog, reads the club's own
 * templates when it opens, and saves through the server fn.
 *
 * The server-fn module is imported DYNAMICALLY, on first use, rather than at
 * the top of this file. `AgendaEditor` renders this, and the editor is
 * deliberately presentational and reachable from vitest without a database —
 * a static import would pull `meeting-templates.ts` → `#/db` into every editor
 * test, and `#/db` throws at import without `DATABASE_URL`.
 *
 * The replace list is `listTemplatesForClub` filtered to the club's OWN rows:
 * the same read the meeting-type picker uses, so the two cannot disagree about
 * which templates exist. That read offers ENABLED templates only; nothing can
 * disable a club template yet, so today that is every one of them.
 */
export function SaveClubTemplateButton({
	meetingId,
	clubUuid,
}: {
	meetingId: string;
	clubUuid: string;
}) {
	const [open, setOpen] = useState(false);
	const [clubTemplates, setClubTemplates] = useState<
		ClubTemplateOption[] | null
	>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	async function load() {
		setClubTemplates(null);
		setLoadError(null);
		try {
			const { listTemplatesForClub } = await import(
				"#/server/meeting-templates"
			);
			const all = await listTemplatesForClub({ data: { clubId: clubUuid } });
			setClubTemplates(
				all
					.filter((t) => t.clubId !== null)
					.map((t) => ({ id: t.id, name: t.name })),
			);
		} catch (err) {
			setLoadError(errMessage(err));
		}
	}

	return (
		<>
			<Button
				type="button"
				variant="outline"
				size="sm"
				onClick={() => {
					setOpen(true);
					void load();
				}}
			>
				Save as club template
			</Button>
			<SaveClubTemplateDialog
				open={open}
				onOpenChange={setOpen}
				clubTemplates={clubTemplates}
				loadError={loadError}
				onSave={async (choice) => {
					const { saveAgendaAsClubTemplate } = await import(
						"#/server/meeting-templates"
					);
					await saveAgendaAsClubTemplate({ data: { meetingId, ...choice } });
				}}
			/>
		</>
	);
}
