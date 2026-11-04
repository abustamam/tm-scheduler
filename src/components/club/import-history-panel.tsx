import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import {
	oversizeMessage,
	SNIFF_HEAD_BYTES,
} from "#/lib/easy-speak-bundle-version";
import {
	type ImportReport,
	isBindingRefusal,
	MAX_UNAPPLIED_IMPORTS,
	type PersonResolution,
	personKeyOf,
} from "#/lib/easy-speak-import-plan";
import { EXTENSION_LISTINGS } from "#/lib/extension-listings";
import { GUEST_KIND_LABELS, GUEST_KINDS } from "#/lib/guest-profile";
import { MAX_BUNDLE_BYTES } from "#/lib/import-bundle-limit";
import { monthLabel } from "#/lib/month-label";
import {
	applyEasySpeakImport,
	importEasySpeakMentors,
	importEasySpeakSpeechRequests,
	listEasySpeakImports,
	nextEasySpeakExport,
	previewEasySpeakImport,
	uploadEasySpeakBundle,
} from "#/server/history-import";

/**
 * The Easy-Speak history import (#1051), on the superadmin club page and, for a
 * club's own admin, at `/admin/import-history` (#1492): upload a bundle, read the
 * preview, decide each person the matcher could not, apply, and read the
 * reconciliation report. Everything here is a server fn behind
 * `requireHistoryImportRunner`; the page only shows what they return.
 */

/** The install line: a link per listing that exists, or who to ask. */
export function ExtensionInstallLine() {
	const links = [
		["Chrome", EXTENSION_LISTINGS.chrome],
		["Firefox", EXTENSION_LISTINGS.firefox],
	].filter((l): l is [string, string] => l[1] !== null);
	return (
		<div className="space-y-1 text-sm" data-testid="extension-install">
			<p className="font-semibold">Install the extension</p>
			{links.length > 0 ? (
				<p>
					Install the GavelUp extension for{" "}
					{links.map(([label, href], i) => (
						<span key={label}>
							{i > 0 ? " or " : ""}
							<a href={href} target="_blank" rel="noreferrer">
								{label}
							</a>
						</span>
					))}
					.
				</p>
			) : (
				<p>Ask GavelUp support for the browser extension.</p>
			)}
			<ol className="list-decimal pl-5 text-muted-foreground">
				<li>Install the extension and sign in to Easy-Speak.</li>
				<li>Press Export and save the file.</li>
				<li>Upload the saved file here.</li>
			</ol>
		</div>
	);
}

const selectClass =
	"h-8 rounded-md border border-border bg-background px-2 text-sm";

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
	isSuperadmin = false,
}: {
	clubId: string;
	clubName: string;
	/** Only a superadmin may import a bundle from another Easy-Speak club (#1492). */
	isSuperadmin?: boolean;
}) {
	const queryClient = useQueryClient();
	const fileRef = useRef<HTMLInputElement>(null);
	const [importId, setImportId] = useState<string | null>(null);
	const [drafts, setDrafts] = useState<Record<string, Draft>>({});
	const [confirming, setConfirming] = useState(false);
	// The optional pasted contacts (#1240). `contacts` is what is typed; the preview
	// reads `contactsRead`, set when the box loses focus, so each keystroke is not
	// a round trip. Sent with the preview and the apply, and kept nowhere else.
	const [contacts, setContacts] = useState("");
	const [contactsRead, setContactsRead] = useState("");
	// The upcoming-meetings box (#1495). `null` until the admin touches it: the
	// server's default for this club (`upcoming.defaultIncluded`, read from the
	// first preview) stands in, so the box is "initialised once" and a later preview
	// cannot flip it back. `skipChoices` holds the roles answered "Skip".
	const [includeChoice, setIncludeChoice] = useState<boolean | null>(null);
	const [skipChoices, setSkipChoices] = useState<Record<string, boolean>>({});
	// A superadmin's override of the club binding (#1492): offered only after an
	// upload or an apply was refused with a binding message, and never rendered
	// for anyone else. `refusedFile` is the upload to retry once it is ticked.
	const [bindingRefused, setBindingRefused] = useState(false);
	const [overrideBinding, setOverrideBinding] = useState(false);
	const [refusedFile, setRefusedFile] = useState<File | null>(null);
	const override = isSuperadmin && overrideBinding ? true : undefined;
	const noteRefusal = (err: unknown, file: File | null = null) => {
		if (err instanceof Error && isBindingRefusal(err.message)) {
			setBindingRefused(true);
			setRefusedFile(file);
		}
	};

	const imports = useQuery({
		queryKey: ["easy-speak-imports", clubId],
		queryFn: () => listEasySpeakImports({ data: { clubId } }),
	});

	// Where the club's next export should start (#1491); display only.
	const nextExport = useQuery({
		queryKey: ["easy-speak-next-export", clubId],
		queryFn: () => nextEasySpeakExport({ data: { clubId } }),
	});

	const resolutions: Record<string, PersonResolution> = {};
	for (const [key, d] of Object.entries(drafts)) {
		const r = toResolution(d);
		if (r) resolutions[key] = r;
	}

	// Sent with every preview and the apply. Absent until the first preview has said
	// what the default is: the server then uses the same default itself.
	const [knownDefault, setKnownDefault] = useState<boolean | null>(null);
	const includeUpcoming = includeChoice ?? knownDefault;
	const upcoming =
		includeUpcoming === null
			? undefined
			: {
					include: includeUpcoming,
					skipRoles: Object.entries(skipChoices)
						.filter(([, skip]) => skip)
						.map(([key]) => key)
						.sort(),
				};

	const preview = useQuery({
		queryKey: [
			"easy-speak-preview",
			clubId,
			importId,
			resolutions,
			contactsRead,
			upcoming ?? null,
		],
		queryFn: async () => {
			const result = await previewEasySpeakImport({
				data: {
					clubId,
					importId: importId as string,
					resolutions,
					contacts: contactsRead,
					...(upcoming ? { upcoming } : {}),
				},
			});
			const server = result.upcoming?.defaultIncluded;
			if (server !== undefined) setKnownDefault((known) => known ?? server);
			return result;
		},
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
		void queryClient.invalidateQueries({
			queryKey: ["easy-speak-next-export", clubId],
		});
	};

	const upload = useMutation({
		mutationFn: async (file: File) => {
			// Refuse before reading: file.text() would pull the whole file into memory.
			if (file.size > MAX_BUNDLE_BYTES) {
				const head = await file.slice(0, SNIFF_HEAD_BYTES).text();
				throw new Error(oversizeMessage(file.size, head));
			}
			return uploadEasySpeakBundle({
				data: {
					clubId,
					text: await file.text(),
					...(override ? { overrideClubBinding: true } : {}),
				},
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
			setIncludeChoice(null);
			setKnownDefault(null);
			setSkipChoices({});
			refresh();
			if (fileRef.current) fileRef.current.value = "";
		},
		onError: (err, file) => {
			noteRefusal(err, file);
			toast.error(err instanceof Error ? err.message : "Upload failed.");
		},
	});

	const apply = useMutation({
		mutationFn: () =>
			applyEasySpeakImport({
				data: {
					clubId,
					importId: importId as string,
					resolutions,
					contacts: contactsRead,
					...(upcoming ? { upcoming } : {}),
					planHash: preview.data?.planHash ?? "",
					...(override ? { overrideClubBinding: true } : {}),
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
			noteRefusal(err);
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

	// The mentor-pair step (#1053): same shape, its own button and result.
	const [mentorsResult, setMentorsResult] = useState<{
		importId: string;
		result: Awaited<ReturnType<typeof importEasySpeakMentors>>;
	} | null>(null);
	const importMentors = useMutation({
		mutationFn: () =>
			importEasySpeakMentors({
				data: { clubId, importId: importId as string },
			}),
		onSuccess: (result) => {
			setMentorsResult({ importId: importId as string, result });
			toast.success(
				result.imported === 0
					? "No new mentor pairs to import."
					: `Imported ${result.imported} mentor ${result.imported === 1 ? "pair" : "pairs"}.`,
			);
		},
		onError: (err) =>
			toast.error(
				err instanceof Error ? err.message : "Mentor pair import failed.",
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
			className="max-w-3xl space-y-4 rounded-xl border border-border bg-surface-raised p-4"
			data-testid="import-history-panel"
		>
			<div className="space-y-1">
				<h2 className="text-sm font-bold">Import Easy-Speak history</h2>
				<p className="text-sm text-muted-foreground">
					Upload the file the browser extension exported for{" "}
					<span className="font-semibold">{clubName}</span>. Nothing is written
					until you apply. Applying again adds nothing that is already there.
					The uploaded bundle, with every guest's name, is kept until the club
					is deleted. Only the club's {MAX_UNAPPLIED_IMPORTS} most recent
					unapplied uploads are kept; an older one is replaced.
				</p>
				{nextExport.data ? (
					<p className="text-sm font-semibold" data-testid="import-next-export">
						{nextExport.data.fromMonth
							? `Next export: from ${monthLabel(nextExport.data.fromMonth)}.`
							: "Next export: the full history."}
					</p>
				) : null}
			</div>

			<ExtensionInstallLine />

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

			{isSuperadmin && bindingRefused ? (
				<div className="flex flex-wrap items-center gap-2 text-sm">
					<label className="inline-flex items-center gap-2">
						<input
							type="checkbox"
							checked={overrideBinding}
							onChange={(e) => setOverrideBinding(e.target.checked)}
						/>
						Import anyway (another Easy-Speak club)
					</label>
					{overrideBinding && refusedFile ? (
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={upload.isPending}
							onClick={() => upload.mutate(refusedFile)}
						>
							Upload again
						</Button>
					) : null}
				</div>
			) : null}

			<div className="space-y-1">
				<label className="text-sm font-semibold" htmlFor="import-contacts">
					Contacts (optional)
				</label>
				<textarea
					id="import-contacts"
					className="min-h-20 w-full rounded-md border border-border bg-background p-2 text-sm"
					placeholder="name, email, phone (one person per line)"
					value={contacts}
					onChange={(e) => setContacts(e.target.value)}
					onBlur={() => setContactsRead(contacts)}
				/>
				<p className="text-xs text-muted-foreground">
					Fills a blank email or phone on a member this import links or creates.
					It is never kept by the import: only the values that land on a person
					are.
				</p>
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
									setIncludeChoice(null);
									setKnownDefault(null);
									setSkipChoices({});
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
					{data.binding ? (
						<p className="text-sm font-semibold" data-testid="import-binding">
							Easy-Speak club {data.binding.esName}
							{data.binding.esNumber ? ` (#${data.binding.esNumber})` : ""}
							{" → "}
							{data.binding.clubName}
						</p>
					) : null}
					<p className="text-sm">
						Bundle from{" "}
						<span className="font-semibold">
							{data.bundleClub.name}
							{data.bundleClub.number ? ` (#${data.bundleClub.number})` : ""}
						</span>
						, importing into{" "}
						<span className="font-semibold">
							{data.club.name}
							{data.club.number ? ` (#${data.club.number})` : ""}
						</span>
						.
					</p>
					{data.range ? (
						<p className="text-sm" data-testid="import-bundle-range">
							This bundle holds meetings from {monthLabel(data.range.fromMonth)}{" "}
							on.
						</p>
					) : null}
					{data.warnings.map((w) => (
						<p key={w} className="text-sm text-warning-foreground">
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
							label="Upcoming meetings not imported"
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

					{data.upcoming ? (
						<UpcomingSection
							upcoming={data.upcoming}
							include={includeUpcoming ?? data.upcoming.included}
							onInclude={setIncludeChoice}
							skipChoices={skipChoices}
							onSkip={(planKey, skip) =>
								setSkipChoices((prev) => ({ ...prev, [planKey]: skip }))
							}
						/>
					) : null}

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

					<p className="text-sm" data-testid="import-people-summary">
						Will link {data.counts.linkedMembers} existing{" "}
						{data.counts.linkedMembers === 1 ? "member" : "members"}, create{" "}
						{data.counts.newActiveMembers} active{" "}
						{data.counts.newActiveMembers === 1 ? "member" : "members"} (
						{data.counts.newOfficers}{" "}
						{data.counts.newOfficers === 1 ? "officer" : "officers"}) and{" "}
						{data.counts.newFormerMembers} former{" "}
						{data.counts.newFormerMembers === 1 ? "member" : "members"}, add{" "}
						{data.counts.newGuests}{" "}
						{data.counts.newGuests === 1 ? "guest" : "guests"}, and skip{" "}
						{data.counts.erasedAccounts} erased{" "}
						{data.counts.erasedAccounts === 1 ? "account" : "accounts"}.
					</p>
					{data.contacts.warnings.length > 0 ? (
						<ul
							className="list-disc space-y-0.5 pl-5 text-sm text-warning-foreground"
							data-testid="import-contact-warnings"
						>
							{data.contacts.warnings.map((w) => (
								<li key={w}>{w}</li>
							))}
						</ul>
					) : null}
					{contactsRead.trim() !== "" ? (
						<p className="text-sm text-muted-foreground">
							Contacts will set {data.contacts.emails}{" "}
							{data.contacts.emails === 1 ? "email" : "emails"} and{" "}
							{data.contacts.phones}{" "}
							{data.contacts.phones === 1 ? "phone" : "phones"}.
						</p>
					) : null}

					<PeopleToResolve
						people={data.people.filter((p) => p.needsDecision)}
						roster={data.roster}
						drafts={drafts}
						setDraft={setDraft}
					/>

					<ListOnlyPeople people={data.people} />

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

					<div className="space-y-1" data-testid="mentors-step">
						<h3 className="text-sm font-bold">Mentor pairs</h3>
						<p className="text-sm text-muted-foreground">
							Adds the bundle's mentor and mentee pairs as mentoring pairings in
							this club, and marks each member whose row says "Wants Mentee?" as
							willing to mentor (it never turns that off, and a member it has
							handled once is not changed by a re-run). Run it after applying
							the import: both people are matched to the people it resolved, and
							a pair with someone it did not resolve is skipped and listed.
							Running it again adds nothing already there.
						</p>
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={!data.appliedAt || importMentors.isPending}
							onClick={() => importMentors.mutate()}
						>
							{importMentors.isPending ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								"Import mentor pairs"
							)}
						</Button>
						{!data.appliedAt ? (
							<p className="text-sm text-muted-foreground">
								Apply the import before importing mentor pairs.
							</p>
						) : null}
						{mentorsResult?.importId === importId ? (
							<MentorsResult result={mentorsResult.result} />
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

const MENTOR_SKIP_LABELS: Record<
	Awaited<
		ReturnType<typeof importEasySpeakMentors>
	>["skipped"][number]["reason"],
	string
> = {
	mentee_unresolved: "the import never matched the mentee to a member",
	mentor_unresolved: "the import never matched the mentor to a member",
	neither_unresolved: "the import never matched either of them to a member",
	mentee_not_member: "the mentee is not an active member",
	mentor_not_member: "the mentor is not an active member",
	neither_not_member: "neither is an active member",
	neither_member:
		"one was never matched to a member and the other is not an active member",
	same_person: "mentor and mentee are the same member",
};

const WILLING_SKIP_LABELS: Record<
	Awaited<
		ReturnType<typeof importEasySpeakMentors>
	>["willing"]["skipped"][number]["reason"],
	string
> = {
	unresolved: "the import never matched them to a member",
	not_member: "not an active member",
};

function MentorsResult({
	result,
}: {
	result: Awaited<ReturnType<typeof importEasySpeakMentors>>;
}) {
	return (
		<div className="space-y-2" data-testid="mentors-result">
			<dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
				<Count label="Rows in the bundle" n={result.total} />
				<Count label="Pairs in the bundle" n={result.pairs} />
				<Count label="Imported" n={result.imported} />
				<Count label="Already imported" n={result.alreadyImported} />
				<Count label="Already paired" n={result.alreadyPaired} />
				<Count label="Skipped" n={result.skipped.length} />
				<Count label="No mentor named" n={result.noMentor} />
			</dl>
			{result.skipped.length > 0 ? (
				<div className="space-y-1" data-testid="mentors-skipped">
					<h4 className="text-sm font-semibold">Pairs not imported</h4>
					<ul className="list-disc space-y-0.5 pl-5 text-sm">
						{result.skipped.map((p, i) => (
							<li
								// The same pair can be listed twice, so the row's position is part of the key.
								// biome-ignore lint/suspicious/noArrayIndexKey: a read-only list with no stable id
								key={`${i}:${personKeyOf(p.mentee)}>${personKeyOf(p.mentor)}`}
							>
								{p.mentee.name} (mentee) with {p.mentor.name} (mentor):{" "}
								{MENTOR_SKIP_LABELS[p.reason]}
							</li>
						))}
					</ul>
				</div>
			) : null}
			<dl
				className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3"
				data-testid="mentors-willing"
			>
				<Count label="Now willing to mentor" n={result.willing.set} />
				<Count label="Already willing" n={result.willing.alreadyWilling} />
				<Count
					label="Handled by an earlier import"
					n={result.willing.previouslyImported}
				/>
				<Count label="Not an active member" n={result.willing.skipped.length} />
			</dl>
			{result.willing.skipped.length > 0 ? (
				<div className="space-y-1" data-testid="mentors-willing-skipped">
					<h4 className="text-sm font-semibold">
						"Wants Mentee?" not imported ({result.willing.skipped.length})
					</h4>
					<ul className="list-disc space-y-0.5 pl-5 text-sm">
						{result.willing.skipped.map((p) => (
							<li key={personKeyOf(p.person)}>
								{p.person.name}: {WILLING_SKIP_LABELS[p.reason]}
							</li>
						))}
					</ul>
				</div>
			) : null}
		</div>
	);
}

function Count({ label, n }: { label: string; n: number }) {
	return (
		<div className="flex justify-between gap-2">
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="font-semibold tabular-nums">{n}</dd>
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
					const fromLists = listAppearances(a);
					return (
						<li
							key={p.key}
							className="space-y-1 rounded-md border border-border p-2 text-sm"
							data-testid={`resolve-${p.key}`}
						>
							<div className="font-semibold">
								{p.name}{" "}
								<span className="font-normal text-muted-foreground">
									{p.status === "ambiguous"
										? "matches more than one member"
										: "is not on the roster"}
									; {a.roles} roles, {a.attendance} attendance, {a.awards}{" "}
									awards, {a.tableTopics} Table Topics
									{fromLists.length > 0 ? `, ${fromLists.join(", ")}` : ""}
									{p.listOnly
										? ". Named by no meeting: it can only be matched to a member or skipped"
										: ""}
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
									{p.listOnly ? null : <option value="guest">A guest</option>}
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

/** Where the member list, the mentor chart and the speech requests name a person. */
function listAppearances(a: PreviewPeople[number]["appearances"]): string[] {
	return [
		a.memberList > 0 ? "on the member list" : null,
		a.mentorChart > 0 ? "in the mentor chart" : null,
		a.speechRequests > 0 ? "in the speech requests" : null,
	].filter((x): x is string => x !== null);
}

/**
 * People only the member list, the mentor chart or the speech requests name
 * (#1203). They are matched to the roster and never created, so there is nothing
 * to decide: this says who got a member and who did not, because the mentor and
 * speech-request steps skip the second group.
 */
function ListOnlyPeople({ people }: { people: PreviewPeople }) {
	const listOnly = people.filter((p) => p.listOnly);
	if (listOnly.length === 0) return null;
	const matched = listOnly.filter((p) => p.status === "member");
	const unmatched = listOnly.filter((p) => p.status === "unmatched");
	return (
		<div className="space-y-1 text-sm" data-testid="list-only-people">
			<h3 className="font-bold">People named only by the lists</h3>
			<p className="text-muted-foreground">
				{matched.length} on the member list, mentor chart or speech requests{" "}
				{matched.length === 1 ? "matches" : "match"} a member and{" "}
				{matched.length === 1 ? "gets" : "get"} a link for the mentor and
				speech-request steps. No guest or member is created for the others.
			</p>
			{unmatched.length > 0 ? (
				<details>
					<summary className="cursor-pointer">
						{unmatched.length} not on the roster, so the later steps skip them
					</summary>
					<ul className="list-disc pl-5">
						{unmatched.map((p) => (
							<li key={p.key} data-testid={`list-only-${p.key}`}>
								{p.name}: {listAppearances(p.appearances).join(", ")}
							</li>
						))}
					</ul>
				</details>
			) : null}
		</div>
	);
}

function ReportView({ report }: { report: ImportReport }) {
	return (
		<div className="space-y-3 border-t border-border pt-3">
			<h3 className="text-sm font-bold">
				Reconciliation report{" "}
				<span
					className={
						report.reconciled ? "text-success" : "font-bold text-destructive"
					}
				>
					{report.reconciled ? "every count matches" : "differences found"}
				</span>
			</h3>
			<table className="w-full text-sm">
				<thead>
					<tr className="text-left text-muted-foreground">
						<th className="font-semibold">Count</th>
						<th className="font-semibold">Bundle</th>
						<th className="font-semibold">GavelUp</th>
						<th className="font-semibold">Missing source ids</th>
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
					<p className="font-semibold text-destructive">
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
				<p className="font-semibold">Intentionally not imported</p>
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
					<p className="font-semibold">People you skipped</p>
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
				{report.created.members
					? `, ${report.created.members.active} active members (${report.created.members.officers} officers) and ${report.created.members.former} former members`
					: ""}
				{report.created.roleDefinitions.length > 0
					? ` and the club roles ${report.created.roleDefinitions.join(", ")}`
					: ""}
				.
			</p>
			{report.contactNotes && report.contactNotes.length > 0 ? (
				<div className="text-sm" data-testid="report-contact-notes">
					<p className="font-semibold">Contacts left out</p>
					<ul className="list-disc pl-5">
						{report.contactNotes.map((n) => (
							<li key={n}>{n}</li>
						))}
					</ul>
				</div>
			) : null}
		</div>
	);
}

type UpcomingPreview = NonNullable<
	Awaited<ReturnType<typeof previewEasySpeakImport>>["upcoming"]
>;

/**
 * The upcoming meetings (#1495): the box, what ticking it would do (shown either
 * way), each meeting left alone, and a role the club's agenda has no slot for with
 * "Add a slot" (the default) or "Skip".
 */
function UpcomingSection({
	upcoming,
	include,
	onInclude,
	skipChoices,
	onSkip,
}: {
	upcoming: UpcomingPreview;
	include: boolean;
	onInclude: (include: boolean) => void;
	skipChoices: Record<string, boolean>;
	onSkip: (planKey: string, skip: boolean) => void;
}) {
	const fill = upcoming.toAdopt + upcoming.toUpdate;
	return (
		<div className="space-y-2" data-testid="import-upcoming">
			<label className="flex items-center gap-2 text-sm font-semibold">
				<input
					type="checkbox"
					checked={include}
					onChange={(e) => onInclude(e.target.checked)}
				/>
				Import upcoming meetings
			</label>
			<p className="text-sm" data-testid="import-upcoming-summary">
				Upcoming: create {upcoming.toCreate}, fill {fill} already in GavelUp,
				leave {upcoming.leftAlone.length} as they are; place{" "}
				{upcoming.roleAssignments} role{" "}
				{upcoming.roleAssignments === 1 ? "holder" : "holders"} and{" "}
				{upcoming.rsvps} {upcoming.rsvps === 1 ? "RSVP" : "RSVPs"}.
			</p>
			{upcoming.leftAlone.length > 0 || upcoming.timeNotes.length > 0 ? (
				<ul
					className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground"
					data-testid="import-upcoming-notes"
				>
					{upcoming.leftAlone.map((m) => (
						<li key={m.esMeetingId}>
							{m.date}: {m.reason}
						</li>
					))}
					{upcoming.timeNotes.map((note) => (
						<li key={note}>{note}</li>
					))}
				</ul>
			) : null}
			{upcoming.unslottedRoles.map((r) => (
				<div
					key={r.planKey}
					className="flex flex-wrap items-center gap-2 text-sm"
					data-testid="import-upcoming-role"
				>
					<span>
						{r.name}: no slot on the club's agenda ({r.holders}{" "}
						{r.holders === 1 ? "holder" : "holders"} over {r.meetings}{" "}
						{r.meetings === 1 ? "meeting" : "meetings"})
					</span>
					<select
						className={selectClass}
						aria-label={`What to do with the ${r.name} role`}
						value={(skipChoices[r.planKey] ?? r.skipped) ? "skip" : "add"}
						onChange={(e) => onSkip(r.planKey, e.target.value === "skip")}
					>
						<option value="add">Add a slot</option>
						<option value="skip">Skip</option>
					</select>
				</div>
			))}
		</div>
	);
}
