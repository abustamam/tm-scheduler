import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import type {
	ImportReport,
	PersonResolution,
} from "#/lib/easy-speak-import-plan";
import { GUEST_KIND_LABELS, GUEST_KINDS } from "#/lib/guest-profile";
import {
	bundleTooBigMessage,
	MAX_BUNDLE_BYTES,
} from "#/lib/import-bundle-limit";
import {
	applyEasySpeakImport,
	importEasySpeakSpeechRequests,
	listEasySpeakImports,
	previewEasySpeakImport,
	uploadEasySpeakBundle,
} from "#/server/history-import";

/**
 * The Easy-Speak history import (#1051), on the superadmin club page: upload a
 * bundle, read the preview, decide each person the matcher could not, apply, and
 * read the reconciliation report. Everything here is a server fn behind
 * `requireSuperadmin`; the page only shows what they return.
 */

const selectClass =
	"h-8 rounded-md border border-[var(--line)] bg-background px-2 text-sm";

/** A calendar day, UTC, as an ISO date: no runtime-resolved locale or zone. */
const isoDay = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

type Choice = "member" | "guest" | "skip";

/** A person's local decision, before it is a `PersonResolution`. */
interface Draft {
	choice: Choice | "";
	memberId: string;
	kind: (typeof GUEST_KINDS)[number];
	reason: string;
}

const EMPTY_DRAFT: Draft = {
	choice: "",
	memberId: "",
	kind: "visitor",
	reason: "",
};

function toResolution(d: Draft): PersonResolution | null {
	if (d.choice === "member" && d.memberId) {
		return { action: "member", memberId: d.memberId };
	}
	if (d.choice === "guest") return { action: "guest", kind: d.kind };
	if (d.choice === "skip" && d.reason.trim()) {
		return { action: "skip", reason: d.reason.trim() };
	}
	return null;
}

export function ImportHistoryPanel({
	clubId,
	clubName,
}: {
	clubId: string;
	clubName: string;
}) {
	const queryClient = useQueryClient();
	const fileRef = useRef<HTMLInputElement>(null);
	const [importId, setImportId] = useState<string | null>(null);
	const [drafts, setDrafts] = useState<Record<string, Draft>>({});
	const [confirming, setConfirming] = useState(false);

	const imports = useQuery({
		queryKey: ["easy-speak-imports", clubId],
		queryFn: () => listEasySpeakImports({ data: { clubId } }),
	});

	const resolutions: Record<string, PersonResolution> = {};
	for (const [key, d] of Object.entries(drafts)) {
		const r = toResolution(d);
		if (r) resolutions[key] = r;
	}

	const preview = useQuery({
		queryKey: ["easy-speak-preview", clubId, importId, resolutions],
		queryFn: () =>
			previewEasySpeakImport({
				data: { clubId, importId: importId as string, resolutions },
			}),
		enabled: importId !== null,
		retry: false,
	});

	const refresh = () => {
		void queryClient.invalidateQueries({
			queryKey: ["easy-speak-imports", clubId],
		});
		void queryClient.invalidateQueries({
			queryKey: ["easy-speak-preview", clubId],
		});
	};

	const upload = useMutation({
		mutationFn: async (file: File) => {
			// Refuse before reading: file.text() would pull the whole file into memory.
			if (file.size > MAX_BUNDLE_BYTES) {
				throw new Error(bundleTooBigMessage(file.size));
			}
			return uploadEasySpeakBundle({
				data: { clubId, text: await file.text() },
			});
		},
		onSuccess: (stored) => {
			toast.success(
				stored.reused
					? "That bundle was already uploaded; opened it."
					: "Bundle uploaded.",
			);
			setImportId(stored.importId);
			setDrafts({});
			refresh();
			if (fileRef.current) fileRef.current.value = "";
		},
		onError: (err) =>
			toast.error(err instanceof Error ? err.message : "Upload failed."),
	});

	const apply = useMutation({
		mutationFn: () =>
			applyEasySpeakImport({
				data: {
					clubId,
					importId: importId as string,
					resolutions,
					planHash: preview.data?.planHash ?? "",
				},
			}),
		onSuccess: (result) => {
			toast.success(
				result.report.reconciled
					? "Imported. Every count matches the bundle."
					: "Imported, with differences. Read the report.",
			);
			setConfirming(false);
			refresh();
		},
		onError: (err) => {
			setConfirming(false);
			toast.error(err instanceof Error ? err.message : "Import failed.");
		},
	});

	// The speech-request queue step (#1052): its own button, after Apply, because
	// it matches requesters to the people Apply resolved.
	const [requestsResult, setRequestsResult] = useState<{
		importId: string;
		result: Awaited<ReturnType<typeof importEasySpeakSpeechRequests>>;
	} | null>(null);
	const importRequests = useMutation({
		mutationFn: () =>
			importEasySpeakSpeechRequests({
				data: { clubId, importId: importId as string },
			}),
		onSuccess: (result) => {
			setRequestsResult({ importId: importId as string, result });
			toast.success(
				result.imported === 0
					? "No new speech requests to import."
					: `Imported ${result.imported} speech ${result.imported === 1 ? "request" : "requests"}.`,
			);
		},
		onError: (err) =>
			toast.error(
				err instanceof Error ? err.message : "Speech request import failed.",
			),
	});

	const data = preview.data;
	const setDraft = (key: string, patch: Partial<Draft>) =>
		setDrafts((prev) => ({
			...prev,
			[key]: { ...(prev[key] ?? EMPTY_DRAFT), ...patch },
		}));

	return (
		<section
			className="max-w-3xl space-y-4 rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] p-4"
			data-testid="import-history-panel"
		>
			<div className="space-y-1">
				<h2 className="text-sm font-bold">Import Easy-Speak history</h2>
				<p className="text-sm text-muted-foreground">
					Upload the JSON bundle the browser extension exported for{" "}
					<span className="font-medium">{clubName}</span>. Nothing is written
					until you apply. Applying again adds nothing that is already there.
					The uploaded bundle, with every guest's name, is kept until the club
					is deleted.
				</p>
			</div>

			<div className="flex flex-wrap items-center gap-2">
				<input
					ref={fileRef}
					type="file"
					accept="application/json,.json"
					className="text-sm"
					aria-label="Easy-Speak bundle"
					disabled={upload.isPending}
					onChange={(e) => {
						const file = e.target.files?.[0];
						if (file) upload.mutate(file);
					}}
				/>
				{upload.isPending ? (
					<span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
						<Loader2 className="size-4 animate-spin" /> Reading the file
					</span>
				) : (
					<Upload className="size-4 text-muted-foreground" aria-hidden />
				)}
			</div>

			{imports.data && imports.data.length > 0 ? (
				<ul className="space-y-1 text-sm">
					{imports.data.map((row) => (
						<li key={row.importId} className="flex flex-wrap gap-2">
							<Button
								type="button"
								variant={row.importId === importId ? "default" : "outline"}
								size="sm"
								onClick={() => {
									setImportId(row.importId);
									setDrafts({});
								}}
							>
								{row.clubName ?? "Bundle"}, {row.meetings} meetings
							</Button>
							<span className="self-center text-muted-foreground">
								uploaded {isoDay(row.createdAt)}
								{row.appliedAt
									? `, applied ${isoDay(row.appliedAt)}${
											row.reconciled === false ? " (with differences)" : ""
										}`
									: ", not applied"}
							</span>
						</li>
					))}
				</ul>
			) : null}

			{importId && preview.isPending ? (
				<p className="text-sm text-muted-foreground">Building the preview...</p>
			) : null}
			{preview.error ? (
				<p className="text-sm text-destructive" role="alert">
					{preview.error instanceof Error
						? preview.error.message
						: "The preview failed."}
				</p>
			) : null}

			{data ? (
				<div className="space-y-4">
					<p className="text-sm">
						Bundle from{" "}
						<span className="font-medium">
							{data.bundleClub.name}
							{data.bundleClub.number ? ` (#${data.bundleClub.number})` : ""}
						</span>
						, importing into{" "}
						<span className="font-medium">
							{data.club.name}
							{data.club.number ? ` (#${data.club.number})` : ""}
						</span>
						.
					</p>
					{data.warnings.map((w) => (
						<p key={w} className="text-sm text-amber-700">
							{w}
						</p>
					))}

					<dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
						<Count label="Meetings" n={data.counts.meetings} />
						<Count label="New meetings" n={data.counts.meetingsToCreate} />
						<Count label="Adopted meetings" n={data.counts.meetingsToAdopt} />
						<Count label="Updated meetings" n={data.counts.meetingsToUpdate} />
						<Count
							label="Left as they are in GavelUp"
							n={data.counts.meetingsToSkip}
						/>
						<Count
							label="Future meetings skipped"
							n={data.counts.futureMeetingsSkipped}
						/>
						<Count label="Role assignments" n={data.counts.roleAssignments} />
						<Count label="Speeches" n={data.counts.speeches} />
						<Count label="Evaluator links" n={data.counts.evaluatorLinks} />
						<Count
							label="Attendance records"
							n={data.counts.attendanceRecords}
						/>
						<Count label="Awards" n={data.counts.awards} />
						<Count
							label="Table Topics speakers"
							n={data.counts.tableTopicsSpeakers}
						/>
						<Count label="New guests" n={data.counts.newGuests} />
						<Count label="New club roles" n={data.counts.newRoleDefinitions} />
					</dl>

					{data.roleDefinitions.some((r) => r.isNew) ? (
						<p className="text-sm text-muted-foreground">
							New club roles:{" "}
							{data.roleDefinitions
								.filter((r) => r.isNew)
								.map((r) => r.name)
								.join(", ")}
							.
						</p>
					) : null}

					<PeopleToResolve
						people={data.people.filter(
							(p) => p.status === "ambiguous" || p.status === "unmatched",
						)}
						roster={data.roster}
						drafts={drafts}
						setDraft={setDraft}
					/>

					{!data.canApply ? (
						<p className="text-sm text-muted-foreground">
							{data.unresolvedCount}{" "}
							{data.unresolvedCount === 1 ? "person needs" : "people need"} a
							decision before this can be applied.
						</p>
					) : null}

					{confirming ? (
						<div className="flex flex-wrap items-center gap-2">
							<span className="text-sm">
								Write {data.counts.meetings} meetings into {data.club.name}?
							</span>
							<Button
								type="button"
								size="sm"
								disabled={apply.isPending}
								onClick={() => apply.mutate()}
							>
								{apply.isPending ? (
									<Loader2 className="size-4 animate-spin" />
								) : (
									"Yes, apply"
								)}
							</Button>
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={apply.isPending}
								onClick={() => setConfirming(false)}
							>
								Cancel
							</Button>
						</div>
					) : (
						<Button
							type="button"
							size="sm"
							disabled={!data.canApply}
							onClick={() => setConfirming(true)}
						>
							Apply import
						</Button>
					)}

					{data.report ? <ReportView report={data.report} /> : null}

					<div className="space-y-1" data-testid="speech-requests-step">
						<h3 className="text-sm font-bold">Speech requests</h3>
						<p className="text-sm text-muted-foreground">
							Adds the bundle's open requests to this club's speech-request
							queue. Run it after applying the import: requesters are matched to
							the people it resolved. Running it again adds nothing already
							there.
						</p>
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={!data.appliedAt || importRequests.isPending}
							onClick={() => importRequests.mutate()}
						>
							{importRequests.isPending ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								"Import speech requests"
							)}
						</Button>
						{!data.appliedAt ? (
							<p className="text-sm text-muted-foreground">
								Apply the import first.
							</p>
						) : null}
						{requestsResult?.importId === importId ? (
							<SpeechRequestsResult result={requestsResult.result} />
						) : null}
					</div>
				</div>
			) : null}
		</section>
	);
}

function SpeechRequestsResult({
	result,
}: {
	result: Awaited<ReturnType<typeof importEasySpeakSpeechRequests>>;
}) {
	return (
		<dl
			className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3"
			data-testid="speech-requests-result"
		>
			<Count label="Requests in the bundle" n={result.total} />
			<Count label="Imported" n={result.imported} />
			<Count label="Already imported" n={result.alreadyImported} />
			<Count label="Skipped: scheduled" n={result.skippedScheduled} />
			<Count label="Skipped: completed" n={result.skippedCompleted} />
			<Count label="Skipped: no matching member" n={result.skippedNoMember} />
			<Count label="Skipped: unknown status" n={result.skippedUnknownStatus} />
		</dl>
	);
}

function Count({ label, n }: { label: string; n: number }) {
	return (
		<div className="flex justify-between gap-2">
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="font-medium tabular-nums">{n}</dd>
		</div>
	);
}

type PreviewPeople = NonNullable<
	Awaited<ReturnType<typeof previewEasySpeakImport>>
>["people"];

function PeopleToResolve({
	people,
	roster,
	drafts,
	setDraft,
}: {
	people: PreviewPeople;
	roster: Array<{ memberId: string; name: string }>;
	drafts: Record<string, Draft>;
	setDraft: (key: string, patch: Partial<Draft>) => void;
}) {
	if (people.length === 0) return null;
	return (
		<div className="space-y-2">
			<h3 className="text-sm font-bold">People to decide</h3>
			<ul className="space-y-2">
				{people.map((p) => {
					const d = drafts[p.key] ?? EMPTY_DRAFT;
					const a = p.appearances;
					return (
						<li
							key={p.key}
							className="space-y-1 rounded-md border border-[var(--line)] p-2 text-sm"
							data-testid={`resolve-${p.key}`}
						>
							<div className="font-medium">
								{p.name}{" "}
								<span className="font-normal text-muted-foreground">
									{p.status === "ambiguous"
										? "matches more than one member"
										: "is not on the roster"}
									; {a.roles} roles, {a.attendance} attendance, {a.awards}{" "}
									awards, {a.tableTopics} Table Topics
								</span>
							</div>
							{p.rejectedChoice ? (
								<p className="text-destructive" role="alert">
									{p.rejectedChoice}
								</p>
							) : null}
							<div className="flex flex-wrap items-center gap-2">
								<select
									className={selectClass}
									aria-label={`What to do with ${p.name}`}
									value={d.choice}
									onChange={(e) =>
										setDraft(p.key, {
											choice: e.target.value as Draft["choice"],
										})
									}
								>
									<option value="">Choose...</option>
									<option value="member">A member</option>
									<option value="guest">A guest</option>
									<option value="skip">Skip</option>
								</select>
								{d.choice === "member" ? (
									<select
										className={selectClass}
										aria-label={`Which member is ${p.name}`}
										value={d.memberId}
										onChange={(e) =>
											setDraft(p.key, { memberId: e.target.value })
										}
									>
										<option value="">Pick a member...</option>
										{(p.candidates.length > 0 ? p.candidates : roster).map(
											(m) => (
												<option key={m.memberId} value={m.memberId}>
													{m.name}
												</option>
											),
										)}
										{p.candidates.length > 0 ? (
											<option disabled>Others on the roster</option>
										) : null}
										{p.candidates.length > 0
											? roster
													.filter(
														(m) =>
															!p.candidates.some(
																(c) => c.memberId === m.memberId,
															),
													)
													.map((m) => (
														<option key={m.memberId} value={m.memberId}>
															{m.name}
														</option>
													))
											: null}
									</select>
								) : null}
								{d.choice === "guest" ? (
									<select
										className={selectClass}
										aria-label={`What kind of guest is ${p.name}`}
										value={d.kind}
										onChange={(e) =>
											setDraft(p.key, {
												kind: e.target.value as Draft["kind"],
											})
										}
									>
										{GUEST_KINDS.map((k) => (
											<option key={k} value={k}>
												{GUEST_KIND_LABELS[k]}
											</option>
										))}
									</select>
								) : null}
								{d.choice === "skip" ? (
									<input
										className={`${selectClass} w-64`}
										aria-label={`Why skip ${p.name}`}
										placeholder="Why is this person skipped?"
										value={d.reason}
										onChange={(e) =>
											setDraft(p.key, { reason: e.target.value })
										}
									/>
								) : null}
							</div>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

function ReportView({ report }: { report: ImportReport }) {
	return (
		<div className="space-y-3 border-t border-[var(--line)] pt-3">
			<h3 className="text-sm font-bold">
				Reconciliation report{" "}
				<span
					className={
						report.reconciled
							? "text-emerald-700"
							: "font-bold text-destructive"
					}
				>
					{report.reconciled ? "every count matches" : "differences found"}
				</span>
			</h3>
			<table className="w-full text-sm">
				<thead>
					<tr className="text-left text-muted-foreground">
						<th className="font-medium">Count</th>
						<th className="font-medium">Bundle</th>
						<th className="font-medium">GavelUp</th>
						<th className="font-medium">Missing source ids</th>
					</tr>
				</thead>
				<tbody>
					{report.counts.map((c) => (
						<tr key={c.key}>
							<td>{c.label}</td>
							<td className="tabular-nums">{c.bundle}</td>
							<td className="tabular-nums">{c.gavelup}</td>
							<td className="break-all">{c.missing.join(", ") || "none"}</td>
						</tr>
					))}
				</tbody>
			</table>
			{report.meetings.failed.length > 0 ? (
				<div className="text-sm" role="alert">
					<p className="font-medium text-destructive">
						{report.meetings.failed.length} meeting(s) failed and were left out
						whole:
					</p>
					<ul className="list-disc pl-5">
						{report.meetings.failed.map((f) => (
							<li key={f.esMeetingId}>
								{f.esMeetingId}: {f.message}
							</li>
						))}
					</ul>
				</div>
			) : null}
			<div className="text-sm">
				<p className="font-medium">Intentionally not imported</p>
				<ul className="list-disc pl-5">
					{report.notImported.map((n) => (
						<li key={n.what}>
							{n.what}: {n.count}. {n.reason}
						</li>
					))}
				</ul>
			</div>
			{report.skippedPeople.length > 0 ? (
				<div className="text-sm">
					<p className="font-medium">People you skipped</p>
					<ul className="list-disc pl-5">
						{report.skippedPeople.map((s) => (
							<li key={s.key}>
								{s.name}: {s.reason}
							</li>
						))}
					</ul>
				</div>
			) : null}
			<p className="text-sm text-muted-foreground">
				Created {report.created.guests} guests
				{report.created.roleDefinitions.length > 0
					? ` and the club roles ${report.created.roleDefinitions.join(", ")}`
					: ""}
				.
			</p>
		</div>
	);
}
