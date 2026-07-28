import { Loader2 } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { toast } from "sonner";
import { ProjectPicker } from "#/components/pathways/project-picker";
import { useProjectOptions } from "#/components/pathways/use-project-options";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
	Sheet,
	SheetClose,
	SheetContent,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "#/components/ui/sheet";
import { speechWindowInputError } from "#/lib/speech-window";
import { updateSpeakerDetails } from "#/server/slots";

type SpeechSlot = {
	id: string;
	label: string;
	speechTitle: string | null;
	pathwayPath: string | null;
	projectName: string | null;
	projectLevel: string | null;
	/** Linked catalog project (#418), pre-selected in the picker. */
	projectId: string | null;
	/** The SPEAKER's member id — whose paths the picker offers. Not the actor:
	 *  an admin editing someone else's speech still picks from THEIR path. */
	assigneeId: string | null;
	minMinutes: number | null;
	maxMinutes: number | null;
	presentationUrl: string | null;
};

export function EditSpeechSheet({
	slot,
	actorMemberId,
	onOpenChange,
	onSaved,
}: {
	slot: SpeechSlot | null;
	actorMemberId: string | null;
	onOpenChange: (open: boolean) => void;
	onSaved: () => void | Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const [projectId, setProjectId] = useState<string | null>(null);
	const [seededFor, setSeededFor] = useState<string | null>(null);
	const paths = useProjectOptions(slot?.assigneeId ?? null, slot !== null);

	// Re-seed from the slot each time the sheet opens on a different speech. The
	// form is remounted by `key`, but this state lives above it, so an abandoned
	// pick would otherwise follow the user to the next slot. Adjusted during
	// render rather than in an effect (React's documented pattern) — `slot` is
	// rebuilt inline by the caller every render, so it can't be an effect dep.
	// Both sides normalize to null: comparing a bare `slot?.id` (undefined with
	// no slot) against null state never settles, and a render-phase update that
	// never settles is an infinite re-render.
	const openSlotId = slot?.id ?? null;
	if (openSlotId !== seededFor) {
		setSeededFor(openSlotId);
		setProjectId(slot?.projectId ?? null);
	}

	async function submit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		if (!slot || !actorMemberId) {
			toast.error("Your account isn't linked to a club member yet.");
			return;
		}
		const form = new FormData(e.currentTarget);
		const minRaw = form.get("minMinutes");
		const maxRaw = form.get("maxMinutes");
		const minMinutes = minRaw ? Number(minRaw) : undefined;
		const maxMinutes = maxRaw ? Number(maxRaw) : undefined;
		// Both or neither (#394). This is also where a LEGACY half-pair gets
		// resolved: the sheet still shows the min that was typed, and this save
		// won't go through until the missing max is supplied by the person who
		// actually knows it — rather than the app inventing one on their behalf.
		const windowError = speechWindowInputError(minMinutes, maxMinutes);
		if (windowError) {
			toast.error(windowError);
			return;
		}
		setBusy(true);
		try {
			await updateSpeakerDetails({
				data: {
					slotId: slot.id,
					actorMemberId,
					speakerDetails: {
						speechTitle:
							String(form.get("speechTitle") ?? "").trim() || undefined,
						// Free text is sent as typed; when `projectId` is set the server
						// overwrites all three from the catalog (#418).
						pathwayPath:
							String(form.get("pathwayPath") ?? "").trim() || undefined,
						projectName:
							String(form.get("projectName") ?? "").trim() || undefined,
						projectLevel:
							String(form.get("projectLevel") ?? "").trim() || undefined,
						projectId,
						minMinutes,
						maxMinutes,
						presentationUrl:
							String(form.get("presentationUrl") ?? "").trim() || undefined,
					},
				},
			});
			toast.success("Speech updated.");
			await onSaved();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<Sheet open={slot !== null} onOpenChange={onOpenChange}>
			<SheetContent side="bottom" className="max-h-[90svh] overflow-y-auto">
				<SheetHeader>
					<SheetTitle>Edit speech — {slot?.label ?? ""}</SheetTitle>
				</SheetHeader>
				{slot ? (
					<form
						key={slot?.id ?? "closed"}
						onSubmit={submit}
						className="space-y-4 px-4 pb-4"
					>
						<div className="space-y-2">
							<Label htmlFor="speechTitle">Speech title</Label>
							<Input
								id="speechTitle"
								name="speechTitle"
								defaultValue={slot.speechTitle ?? ""}
								placeholder="TBA"
								autoFocus
							/>
						</div>
						<ProjectPicker
							paths={paths}
							value={projectId}
							onChange={setProjectId}
							fallback={{
								pathwayPath: slot.pathwayPath,
								projectName: slot.projectName,
								projectLevel: slot.projectLevel,
							}}
						/>
						<div className="grid grid-cols-2 gap-3">
							<div className="space-y-2">
								<Label htmlFor="minMinutes">Min minutes</Label>
								<Input
									id="minMinutes"
									name="minMinutes"
									type="number"
									inputMode="numeric"
									min={1}
									defaultValue={slot.minMinutes ?? ""}
									placeholder="4"
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="maxMinutes">Max minutes</Label>
								<Input
									id="maxMinutes"
									name="maxMinutes"
									type="number"
									inputMode="numeric"
									min={1}
									defaultValue={slot.maxMinutes ?? ""}
									placeholder="6"
								/>
							</div>
						</div>
						<div className="space-y-2">
							<Label htmlFor="presentationUrl">Presentation link</Label>
							<Input
								id="presentationUrl"
								name="presentationUrl"
								type="url"
								inputMode="url"
								defaultValue={slot.presentationUrl ?? ""}
								placeholder="https://…  (speaker's slides)"
							/>
						</div>
						<SheetFooter className="px-0">
							<Button type="submit" disabled={busy} className="w-full">
								{busy ? (
									<Loader2 className="size-4 animate-spin" />
								) : (
									"Save speech"
								)}
							</Button>
							<SheetClose asChild>
								<Button type="button" variant="ghost" className="w-full">
									Cancel
								</Button>
							</SheetClose>
						</SheetFooter>
					</form>
				) : null}
			</SheetContent>
		</Sheet>
	);
}
