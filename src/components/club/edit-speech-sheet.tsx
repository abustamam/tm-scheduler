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
import { Textarea } from "#/components/ui/textarea";
import { showWriteError } from "#/components/write-error-toast";
import { SPEAKER_LIMITS } from "#/lib/speaker-limits";
import { speechWindowInputError } from "#/lib/speech-window";
import { updateSpeakerDetails } from "#/server/slots";
import {
	addPastSpeechFn,
	deletePastSpeechFn,
	editPastSpeechFn,
	editSpeechFromLog,
} from "#/server/speeches";

const MONTH_NAMES = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];
/** The lowest year the Year select lists by name; older ones use "Earlier…". */
const YEAR_LIST_FLOOR = 1990;
const EARLIER = "earlier";

const SELECT_CLASS =
	"border-input bg-transparent h-9 w-full rounded-md border px-3 text-sm shadow-xs disabled:cursor-not-allowed disabled:opacity-50";

/** A speech given outside any meeting (#1656): where it is recorded, and its
 *  loose date. `speechId` null means a new one (`memberId` is whose). */
export type PastSpeechTarget = {
	speechId: string | null;
	memberId: string | null;
	deliveredYear: number | null;
	deliveredMonth: number | null;
};

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
	/** The stored introduction. MEMBERS-ONLY text, so `undefined` means the
	 *  viewer may not read it: the field is then not drawn and not sent, and the
	 *  server keeps what is stored. `null` is "readable, and there is none". */
	introduction?: string | null;
	/** Set for the `past-speech` writer (#1656). */
	past?: PastSpeechTarget;
};

export function EditSpeechSheet({
	slot,
	onOpenChange,
	onSaved,
	writer = "agenda",
}: {
	slot: SpeechSlot | null;
	onOpenChange: (open: boolean) => void;
	onSaved: () => void | Promise<void>;
	/** Which server fn saves (#1159). `agenda` (default) is `updateSpeakerDetails`:
	 *  open meetings only, a blank save unlinks. `speech-log` is `editSpeechFromLog`:
	 *  completed meetings too, never unlinks. The sheet chooses; no fn is a prop. */
	writer?: "agenda" | "speech-log" | "past-speech";
}) {
	const [busy, setBusy] = useState(false);
	const [projectId, setProjectId] = useState<string | null>(null);
	const [seededFor, setSeededFor] = useState<string | null>(null);
	const [yearChoice, setYearChoice] = useState("");
	const [earlierYear, setEarlierYear] = useState("");
	const [monthChoice, setMonthChoice] = useState("");
	const [confirmingDelete, setConfirmingDelete] = useState(false);
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
		const y = slot?.past?.deliveredYear ?? null;
		setYearChoice(y === null ? "" : y < YEAR_LIST_FLOOR ? EARLIER : String(y));
		setEarlierYear(y !== null && y < YEAR_LIST_FLOOR ? String(y) : "");
		setMonthChoice(
			slot?.past?.deliveredMonth ? String(slot.past.deliveredMonth) : "",
		);
		setConfirmingDelete(false);
	}
	const thisYear = new Date().getFullYear();
	const yearOptions: number[] = [];
	for (let y = thisYear; y >= YEAR_LIST_FLOOR; y--) yearOptions.push(y);
	const pastYear =
		yearChoice === ""
			? null
			: yearChoice === EARLIER
				? earlierYear === ""
					? null
					: Number(earlierYear)
				: Number(yearChoice);
	// The server refuses a month after the current one in the current year, by
	// the RECORDING club's timezone, which the sheet does not have. So the sheet
	// only limits what it newly OFFERS (by the browser's clock) and never drops or
	// hides a month already chosen or stored: the select always carries the
	// current value and a save sends it as shown. A genuinely future month is
	// refused by the server and surfaces as that error. A leftover month that the
	// current year would refuse is cleared visibly when the YEAR is changed to it
	// (an explicit action), never on render.
	const currentMonth = new Date().getMonth() + 1;
	const offeredMonths = Math.max(
		pastYear === thisYear ? currentMonth : 12,
		Number(monthChoice) || 0,
	);
	const shownMonth = monthChoice;

	async function removePast() {
		const speechId = slot?.past?.speechId;
		if (!speechId) return;
		setBusy(true);
		try {
			await deletePastSpeechFn({ data: { speechId } });
			toast.success("Speech deleted.");
			await onSaved();
		} catch (err) {
			showWriteError(err, "Something went wrong.");
		} finally {
			setBusy(false);
		}
	}

	async function submit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		// No actor on the wire (#763): `updateSpeakerDetails` resolves it from the
		// session, so an impersonating superadmin with no member id can save too.
		if (!slot) return;
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
		// Free text is sent as typed; when `projectId` is set the server overwrites
		// all three from the catalog (#418). The picker HIDES these inputs for a
		// member with a path, so on the speech-log writer an input that is not on
		// the form is left out (the server keeps what is stored) and one that is
		// there but empty is sent as "" (a deliberate clear). The agenda writer
		// keeps its behaviour: empty is undefined.
		const freeText = (name: string) => {
			// A past speech is a full replace on the server, so a hidden input
			// resends the stored text instead of leaving it unsent.
			if (writer === "past-speech" && !form.has(name)) {
				return (
					(slot?.[name as "pathwayPath" | "projectName" | "projectLevel"] ??
						"") ||
					""
				);
			}
			if (writer === "speech-log" && !form.has(name)) return undefined;
			const value = String(form.get(name) ?? "").trim();
			return value || (writer !== "agenda" ? "" : undefined);
		};
		// Shown (so prefilled) means the value is the person's to clear: sent as
		// "" when emptied. Not shown means unsent, and the server keeps the stored
		// text (a blank key would be read as "no introduction" and wipe it).
		const introduction =
			slot.introduction === undefined
				? undefined
				: String(form.get("introduction") ?? "").trim();
		setBusy(true);
		try {
			const speakerDetails = {
				speechTitle: String(form.get("speechTitle") ?? "").trim() || undefined,
				pathwayPath: freeText("pathwayPath"),
				projectName: freeText("projectName"),
				projectLevel: freeText("projectLevel"),
				projectId,
				introduction,
				minMinutes,
				maxMinutes,
				presentationUrl:
					String(form.get("presentationUrl") ?? "").trim() || undefined,
			};
			if (writer === "past-speech") {
				const past = slot.past;
				if (!past) throw new Error("Past speech target missing.");
				const dates = {
					deliveredYear: pastYear,
					deliveredMonth:
						pastYear !== null && shownMonth !== "" ? Number(shownMonth) : null,
				};
				if (past.speechId) {
					await editPastSpeechFn({
						data: { speechId: past.speechId, speakerDetails, ...dates },
					});
				} else if (past.memberId) {
					await addPastSpeechFn({
						data: { memberId: past.memberId, speakerDetails, ...dates },
					});
				}
			} else {
				const save =
					writer === "speech-log" ? editSpeechFromLog : updateSpeakerDetails;
				await save({ data: { slotId: slot.id, speakerDetails } });
			}
			toast.success(
				writer === "past-speech" && !slot.past?.speechId
					? "Past speech added."
					: "Speech updated.",
			);
			await onSaved();
		} catch (err) {
			showWriteError(err, "Something went wrong.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<Sheet open={slot !== null} onOpenChange={onOpenChange}>
			<SheetContent side="bottom" className="max-h-[90svh] overflow-y-auto">
				<SheetHeader>
					<SheetTitle>
						{writer === "past-speech" && slot && !slot.past?.speechId
							? "Add past speech"
							: "Edit speech"}{" "}
						— {slot?.label ?? ""}
					</SheetTitle>
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
						{slot.introduction !== undefined ? (
							<div className="space-y-2">
								<Label htmlFor="introduction">Introduction</Label>
								<Textarea
									id="introduction"
									name="introduction"
									defaultValue={slot.introduction ?? ""}
									maxLength={SPEAKER_LIMITS.introduction}
									rows={4}
								/>
							</div>
						) : null}
						{writer === "past-speech" ? (
							<div className="grid grid-cols-2 gap-3">
								<div className="space-y-2">
									<Label htmlFor="deliveredYear">Year (optional)</Label>
									<select
										id="deliveredYear"
										className={SELECT_CLASS}
										value={yearChoice}
										onChange={(e) => {
											const next = e.target.value;
											setYearChoice(next);
											if (
												next === "" ||
												(next === String(thisYear) &&
													Number(monthChoice) > currentMonth)
											)
												setMonthChoice("");
										}}
									>
										<option value="">Not sure</option>
										{yearOptions.map((y) => (
											<option key={y} value={String(y)}>
												{y}
											</option>
										))}
										<option value={EARLIER}>Earlier…</option>
									</select>
									{yearChoice === EARLIER ? (
										<Input
											aria-label="Year before 1990"
											type="number"
											inputMode="numeric"
											min={1900}
											max={YEAR_LIST_FLOOR - 1}
											value={earlierYear}
											onChange={(e) => setEarlierYear(e.target.value)}
											placeholder="1985"
										/>
									) : null}
								</div>
								<div className="space-y-2">
									<Label htmlFor="deliveredMonth">Month (optional)</Label>
									<select
										id="deliveredMonth"
										className={SELECT_CLASS}
										value={shownMonth}
										disabled={pastYear === null}
										onChange={(e) => setMonthChoice(e.target.value)}
									>
										<option value="">Not sure</option>
										{MONTH_NAMES.slice(0, offeredMonths).map((m, i) => (
											<option key={m} value={String(i + 1)}>
												{m}
											</option>
										))}
									</select>
								</div>
							</div>
						) : null}
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
							{writer === "past-speech" && slot.past?.speechId ? (
								confirmingDelete ? (
									<div className="space-y-2 rounded-md border border-destructive/40 p-3">
										<p className="text-sm">Delete this speech for good?</p>
										<div className="flex gap-2">
											<Button
												type="button"
												variant="destructive"
												disabled={busy}
												onClick={removePast}
											>
												Yes, delete
											</Button>
											<Button
												type="button"
												variant="ghost"
												onClick={() => setConfirmingDelete(false)}
											>
												Keep it
											</Button>
										</div>
									</div>
								) : (
									<Button
										type="button"
										variant="outline"
										className="w-full"
										onClick={() => setConfirmingDelete(true)}
									>
										Delete speech
									</Button>
								)
							) : null}
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
