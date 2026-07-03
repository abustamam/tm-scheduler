import { Loader2 } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { toast } from "sonner";
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
import { updateSpeakerDetails } from "#/server/slots";

type SpeechSlot = {
	id: string;
	label: string;
	speechTitle: string | null;
	pathwayPath: string | null;
	projectName: string | null;
	projectLevel: string | null;
	minMinutes: number | null;
	maxMinutes: number | null;
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

	async function submit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		if (!slot || !actorMemberId) {
			toast.error("Your account isn't linked to a club member yet.");
			return;
		}
		const form = new FormData(e.currentTarget);
		const minRaw = form.get("minMinutes");
		const maxRaw = form.get("maxMinutes");
		setBusy(true);
		try {
			await updateSpeakerDetails({
				data: {
					slotId: slot.id,
					actorMemberId,
					speakerDetails: {
						speechTitle:
							String(form.get("speechTitle") ?? "").trim() || undefined,
						pathwayPath:
							String(form.get("pathwayPath") ?? "").trim() || undefined,
						projectName:
							String(form.get("projectName") ?? "").trim() || undefined,
						projectLevel:
							String(form.get("projectLevel") ?? "").trim() || undefined,
						minMinutes: minRaw ? Number(minRaw) : undefined,
						maxMinutes: maxRaw ? Number(maxRaw) : undefined,
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
						<div className="space-y-2">
							<Label htmlFor="pathwayPath">Pathways path</Label>
							<Input
								id="pathwayPath"
								name="pathwayPath"
								defaultValue={slot.pathwayPath ?? ""}
								placeholder="e.g. Presentation Mastery"
							/>
						</div>
						<div className="grid grid-cols-2 gap-3">
							<div className="space-y-2">
								<Label htmlFor="projectName">Project</Label>
								<Input
									id="projectName"
									name="projectName"
									defaultValue={slot.projectName ?? ""}
									placeholder="Ice Breaker"
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="projectLevel">Level</Label>
								<Input
									id="projectLevel"
									name="projectLevel"
									defaultValue={slot.projectLevel ?? ""}
									placeholder="Level 1"
								/>
							</div>
						</div>
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
