// The Charter section of club settings (#944). A chartering club's admin marks
// it chartered here, with the charter date and club number; a chartered club's
// admin corrects its charter date. Moving BACK to chartering is not offered: it
// is superadmin-only, from the console.
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
	CHARTER_STATUS_LABEL,
	type CharterStatus,
	CLUB_NUMBER_MAX,
	CLUB_NUMBER_PATTERN,
	CLUB_NUMBER_REQUIRED_MESSAGE,
} from "#/lib/club-charter";
import { markChartered, updateCharterDate } from "#/server/clubs";

export const CHARTER_COPY = {
	title: "Charter",
	chartering:
		"Your club is chartering. Once it has chartered, record the charter date and your club number here.",
	chartered: "Your club is chartered.",
	charterDateLabel: "Charter date",
	clubNumberLabel: "Club number",
	markCta: "Mark as chartered",
	saveDateCta: "Save charter date",
	dateRequired: "Enter the charter date.",
	markSuccess: "Your club is now chartered.",
	dateSuccess: "Charter date saved.",
	revertNote:
		"Marked chartered by mistake? Contact us to move your club back to chartering.",
} as const;

export interface CharterSettingsProps {
	clubId: string;
	charterStatus: CharterStatus;
	charteredAt: string | null;
	clubNumber: string | null;
	onSaved: () => void | Promise<void>;
}

export function CharterSettings(props: CharterSettingsProps) {
	return (
		<>
			<div className="pt-2">
				<h2 className="font-display text-xl font-semibold tracking-[-0.01em]">
					{CHARTER_COPY.title}
				</h2>
				<p className="text-sm text-muted-foreground">
					<span
						data-testid="charter-status"
						className="mr-1 inline-block rounded-full bg-[var(--sand)] px-2 py-0.5 text-xs font-semibold text-[var(--sea-ink-soft)] uppercase tracking-[0.04em]"
					>
						{CHARTER_STATUS_LABEL[props.charterStatus]}
					</span>{" "}
					{props.charterStatus === "chartering"
						? CHARTER_COPY.chartering
						: CHARTER_COPY.chartered}
				</p>
			</div>
			{props.charterStatus === "chartering" ? (
				<MarkCharteredForm {...props} />
			) : (
				<CharterDateForm {...props} />
			)}
		</>
	);
}

function MarkCharteredForm({
	clubId,
	clubNumber,
	onSaved,
}: CharterSettingsProps) {
	const [date, setDate] = useState("");
	const [number, setNumber] = useState(clubNumber ?? "");
	const [saving, setSaving] = useState(false);

	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		// The same two refusals the server makes, before the round trip, so the
		// admin sees which field is missing rather than a ZodError's JSON.
		if (!date.trim()) {
			toast.error(CHARTER_COPY.dateRequired);
			return;
		}
		if (!number.trim()) {
			toast.error(CLUB_NUMBER_REQUIRED_MESSAGE);
			return;
		}
		setSaving(true);
		try {
			await markChartered({
				data: { clubId, charteredAt: date, clubNumber: number },
			});
			toast.success(CHARTER_COPY.markSuccess);
			await onSaved();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setSaving(false);
		}
	}

	return (
		<form onSubmit={onSubmit} className="max-w-xl space-y-4">
			<div className="space-y-2">
				<Label htmlFor="charterDate">{CHARTER_COPY.charterDateLabel}</Label>
				<Input
					id="charterDate"
					type="date"
					required
					value={date}
					onChange={(e) => setDate(e.target.value)}
					className="max-w-[12rem]"
				/>
			</div>
			<div className="space-y-2">
				<Label htmlFor="charterClubNumber">
					{CHARTER_COPY.clubNumberLabel}
				</Label>
				<Input
					id="charterClubNumber"
					required
					inputMode="numeric"
					pattern={CLUB_NUMBER_PATTERN}
					maxLength={CLUB_NUMBER_MAX}
					value={number}
					onChange={(e) => setNumber(e.target.value)}
					placeholder="e.g. 1234567"
					className="max-w-[12rem]"
				/>
			</div>
			<Button
				type="submit"
				data-testid="mark-chartered"
				disabled={saving}
				className="w-full"
			>
				{saving ? (
					<Loader2 className="size-4 animate-spin" />
				) : (
					CHARTER_COPY.markCta
				)}
			</Button>
		</form>
	);
}

function CharterDateForm({
	clubId,
	charteredAt,
	onSaved,
}: CharterSettingsProps) {
	const [date, setDate] = useState(charteredAt ?? "");
	const [saving, setSaving] = useState(false);

	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		if (!date.trim()) {
			toast.error(CHARTER_COPY.dateRequired);
			return;
		}
		setSaving(true);
		try {
			await updateCharterDate({ data: { clubId, charteredAt: date } });
			toast.success(CHARTER_COPY.dateSuccess);
			await onSaved();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setSaving(false);
		}
	}

	return (
		<form onSubmit={onSubmit} className="max-w-xl space-y-4">
			<div className="space-y-2">
				<Label htmlFor="charterDate">{CHARTER_COPY.charterDateLabel}</Label>
				<Input
					id="charterDate"
					type="date"
					required
					value={date}
					onChange={(e) => setDate(e.target.value)}
					className="max-w-[12rem]"
				/>
				<p className="text-xs text-muted-foreground">
					{CHARTER_COPY.revertNote}
				</p>
			</div>
			<Button
				type="submit"
				data-testid="save-charter-date"
				disabled={saving}
				className="w-full"
			>
				{saving ? (
					<Loader2 className="size-4 animate-spin" />
				) : (
					CHARTER_COPY.saveDateCta
				)}
			</Button>
		</form>
	);
}
