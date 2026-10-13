import { useRouter } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Textarea } from "#/components/ui/textarea";
import { formatCalendarDay, formatMeetingDate } from "#/lib/format";
import { SPEAKER_LIMITS } from "#/lib/speaker-limits";
import {
	MAX_PREFERRED_DATES,
	UNTITLED_REQUEST_LABEL,
} from "#/lib/speech-requests";
import {
	editSpeechRequest,
	type MySpeechRequest,
	submitSpeechRequest,
	withdrawMySpeechRequest,
} from "#/server/speech-requests";

/**
 * The member's own speech requests (#1052), on "My commitments": ask for a speech
 * with up to three preferred dates, edit or withdraw an open request, and see
 * where a scheduled one went. The VPE schedules from the queue; the server fns
 * refuse anyone else's request.
 */
export function MySpeechRequests({
	clubId,
	requests,
}: {
	clubId: string;
	requests: MySpeechRequest[];
}) {
	const router = useRouter();
	const [adding, setAdding] = useState(false);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);

	async function withdraw(id: string) {
		setBusyId(id);
		try {
			await withdrawMySpeechRequest({ data: { requestId: id } });
			toast.success("Request withdrawn.");
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusyId(null);
		}
	}

	return (
		<section
			className="space-y-3 rounded-xl border bg-card p-4 shadow-sm"
			data-testid="my-speech-requests"
		>
			<div className="flex items-center justify-between gap-2">
				<div>
					<h2 className="font-semibold">Speech requests</h2>
					<p className="text-sm text-muted-foreground">
						Ask for a speech and name up to {MAX_PREFERRED_DATES} dates that
						suit you. The VP Education schedules from the queue.
					</p>
				</div>
				{adding ? null : (
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={() => setAdding(true)}
					>
						Request a speech
					</Button>
				)}
			</div>

			{adding ? (
				<RequestForm
					label="Send request"
					onSubmit={async (fields) => {
						await submitSpeechRequest({ data: { clubId, ...fields } });
						toast.success("Request sent.");
						setAdding(false);
						await router.invalidate();
					}}
					onCancel={() => setAdding(false)}
				/>
			) : null}

			{requests.length === 0 && !adding ? (
				<p className="text-sm text-muted-foreground">
					You have no open speech requests.
				</p>
			) : null}

			<ul className="space-y-2">
				{requests.map((r) =>
					editingId === r.id ? (
						<li key={r.id}>
							<RequestForm
								label="Save changes"
								initial={r}
								onSubmit={async (fields) => {
									await editSpeechRequest({
										data: { requestId: r.id, ...fields },
									});
									toast.success("Request updated.");
									setEditingId(null);
									await router.invalidate();
								}}
								onCancel={() => setEditingId(null)}
							/>
						</li>
					) : (
						<li
							key={r.id}
							className="flex flex-wrap items-start justify-between gap-2 rounded-lg border p-3 text-sm"
						>
							<div className="min-w-0 space-y-0.5">
								<div className="font-medium">
									{r.title ?? (
										<span className="text-muted-foreground">
											{UNTITLED_REQUEST_LABEL}
										</span>
									)}
								</div>
								{r.path || r.projectName ? (
									<div className="text-muted-foreground">
										{[r.path, r.projectName].filter(Boolean).join(" · ")}
									</div>
								) : null}
								<div className="text-muted-foreground">
									{r.status === "scheduled"
										? r.scheduledFor
											? `Scheduled for ${formatMeetingDate(r.scheduledFor, r.timezone)}`
											: "Scheduled"
										: r.preferredDates.length > 0
											? `Prefers ${r.preferredDates.map((d) => formatCalendarDay(d)).join(", ")}`
											: "No preferred dates"}
								</div>
							</div>
							{r.status === "open" ? (
								<div className="flex gap-2">
									<Button
										type="button"
										size="sm"
										variant="outline"
										onClick={() => setEditingId(r.id)}
									>
										Edit
									</Button>
									<Button
										type="button"
										size="sm"
										variant="outline"
										disabled={busyId === r.id}
										onClick={() => withdraw(r.id)}
									>
										{busyId === r.id ? (
											<Loader2 className="size-4 animate-spin" />
										) : (
											"Withdraw"
										)}
									</Button>
								</div>
							) : null}
						</li>
					),
				)}
			</ul>
		</section>
	);
}

interface FormFields {
	title: string;
	path: string;
	projectName: string;
	introduction: string;
	preferredDates: string[];
}

function RequestForm({
	label,
	initial,
	onSubmit,
	onCancel,
}: {
	label: string;
	initial?: MySpeechRequest;
	onSubmit: (fields: FormFields) => Promise<void>;
	onCancel: () => void;
}) {
	const [title, setTitle] = useState(initial?.title ?? "");
	const [path, setPath] = useState(initial?.path ?? "");
	const [projectName, setProjectName] = useState(initial?.projectName ?? "");
	const [introduction, setIntroduction] = useState(initial?.introduction ?? "");
	const [dates, setDates] = useState<string[]>(() =>
		Array.from(
			{ length: MAX_PREFERRED_DATES },
			(_, i) => initial?.preferredDates[i] ?? "",
		),
	);
	const [busy, setBusy] = useState(false);
	const uid = useId();

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setBusy(true);
		try {
			await onSubmit({
				title,
				path,
				projectName,
				introduction,
				preferredDates: dates.filter(Boolean),
			});
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<form onSubmit={submit} className="space-y-2 rounded-lg border p-3">
			<label htmlFor={`${uid}-title`} className="block text-sm">
				<span className="font-medium">Speech title</span>
				<Input
					id={`${uid}-title`}
					value={title}
					maxLength={SPEAKER_LIMITS.speechTitle}
					onChange={(e) => setTitle(e.target.value)}
				/>
			</label>
			<div className="grid gap-2 sm:grid-cols-2">
				<label htmlFor={`${uid}-path`} className="block text-sm">
					<span className="font-medium">Path</span>
					<Input
						id={`${uid}-path`}
						value={path}
						maxLength={SPEAKER_LIMITS.pathwayPath}
						onChange={(e) => setPath(e.target.value)}
					/>
				</label>
				<label htmlFor={`${uid}-project`} className="block text-sm">
					<span className="font-medium">Project</span>
					<Input
						id={`${uid}-project`}
						value={projectName}
						maxLength={SPEAKER_LIMITS.projectName}
						onChange={(e) => setProjectName(e.target.value)}
					/>
				</label>
			</div>
			<label htmlFor={`${uid}-intro`} className="block text-sm">
				<span className="font-medium">Introduction</span>
				<Textarea
					id={`${uid}-intro`}
					value={introduction}
					maxLength={SPEAKER_LIMITS.introduction}
					onChange={(e) => setIntroduction(e.target.value)}
				/>
			</label>
			<fieldset className="space-y-1">
				<legend className="text-sm font-medium">
					Preferred dates (up to {MAX_PREFERRED_DATES})
				</legend>
				<div className="flex flex-wrap gap-2">
					{dates.map((d, i) => (
						<Input
							// biome-ignore lint/suspicious/noArrayIndexKey: three fixed slots
							key={i}
							type="date"
							className="w-auto"
							aria-label={`Preferred date ${i + 1}`}
							value={d}
							onChange={(e) =>
								setDates((prev) =>
									prev.map((p, j) => (j === i ? e.target.value : p)),
								)
							}
						/>
					))}
				</div>
			</fieldset>
			<div className="flex gap-2">
				<Button type="submit" size="sm" disabled={busy}>
					{busy ? <Loader2 className="size-4 animate-spin" /> : label}
				</Button>
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={busy}
					onClick={onCancel}
				>
					Cancel
				</Button>
			</div>
		</form>
	);
}
