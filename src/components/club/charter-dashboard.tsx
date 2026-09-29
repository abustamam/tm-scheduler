// The charter dashboard (#943): a chartering club's paid members against its
// target, its charter checklist, and its sponsors and club mentors. All of it
// is the club's own, self-reported tracking — the official-requirements note is
// always shown, and no Toastmasters International form content appears here
// (ADR-0024). Marking the club chartered lives in club settings (#944); this
// links there rather than repeating it.
import { Link } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, ExternalLink, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
	CHARTER_HELPER_FIELD_MAX,
	CHARTER_HELPER_ROLE_LABEL,
	CHARTER_HELPER_ROLES,
	CHARTER_STEP_LABEL_MAX,
	type CharterHelperRole,
	charterProgressPercent,
	MEMBERS_NEEDED_MAX,
	MEMBERS_NEEDED_MIN,
	moveInOrder,
	OFFICIAL_REQUIREMENTS_LINK_LABEL,
	OFFICIAL_REQUIREMENTS_NOTE,
	OFFICIAL_REQUIREMENTS_URL,
} from "#/lib/charter-dashboard";
import {
	addCharterHelper,
	addCharterStep,
	removeCharterHelper,
	removeCharterStep,
	renameCharterStep,
	reorderCharterSteps,
	setCharterStepDone,
	startCharterChecklist,
	updateCharterTarget,
} from "#/server/charter";
import type {
	CharterDashboard as CharterDashboardData,
	CharterStep,
} from "#/server/charter-logic";

export const CHARTER_DASHBOARD_COPY = {
	title: "Charter dashboard",
	intro:
		"Track how close your club is to charter: paid members, the steps done, and who is helping.",
	chartered:
		"Your club has chartered, so this dashboard is closed. Its checklist and helpers are kept.",
	markChartered: "Chartered? Mark it in club settings",
	target: "Paid members",
	progress: (paid: number, needed: number) => `${paid} of ${needed}`,
	pickPeriod:
		"Pick the dues period your charter dues are recorded in, and the paid count will follow it.",
	noPeriods: "No dues periods yet. Add one in the dues tracker first.",
	duesLink: "Open the dues tracker",
	membersNeededLabel: "Members needed",
	periodLabel: "Dues period counted",
	noPeriodOption: "None selected",
	saveTarget: "Save target",
	checklist: "Charter checklist",
	checklistNote:
		"Your own list of steps. Add, rename, reorder or remove any of them.",
	addStepLabel: "New step",
	addStep: "Add step",
	notStarted:
		"These are suggested steps. Start the checklist to edit them, or add your own.",
	startChecklist: "Start checklist",
	targetSaved: "Target saved.",
	doneOnLabel: (label: string) => `Done on (${label})`,
	helpers: "Sponsors and club mentors",
	noHelpers: "No sponsors or club mentors recorded yet.",
	roleLabel: "Role",
	fromRosterLabel: "From your roster",
	outsideOption: "Someone outside the club",
	nameLabel: "Name",
	emailLabel: "Email",
	phoneLabel: "Phone",
	homeClubLabel: "Home club",
	addHelper: "Add helper",
	nameRequired: "Enter the helper's name, or pick them from your roster.",
} as const;

const selectClass =
	"flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

const cardClass =
	"space-y-4 rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] p-4 sm:p-5";

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : "Something went wrong.";
}

/**
 * The one shape every control here shares: mark busy, run the write, refresh,
 * and toast the error (or an optional success) either way.
 */
function useCharterAction(onChanged: () => void | Promise<void>) {
	const [busy, setBusy] = useState(false);
	async function run(
		action: () => Promise<unknown>,
		success?: string,
	): Promise<void> {
		setBusy(true);
		try {
			await action();
			if (success) toast.success(success);
			await onChanged();
		} catch (err) {
			toast.error(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}
	return { busy, run };
}

/** The note every view of the dashboard carries, chartered or not. */
export function OfficialRequirementsNote() {
	return (
		<p
			data-testid="charter-official-note"
			className="rounded-lg border border-[var(--line)] bg-[var(--sand)] px-3 py-2 text-sm text-[var(--sea-ink)]"
		>
			{OFFICIAL_REQUIREMENTS_NOTE}{" "}
			<a
				href={OFFICIAL_REQUIREMENTS_URL}
				target="_blank"
				rel="noopener noreferrer"
				className="inline-flex items-center gap-1 font-semibold underline"
			>
				{OFFICIAL_REQUIREMENTS_LINK_LABEL}
				<ExternalLink className="size-3.5" aria-hidden />
			</a>
		</p>
	);
}

export interface CharterDashboardProps {
	clubId: string;
	/** Null once the club has chartered: the dashboard is hidden. */
	dashboard: CharterDashboardData | null;
	onChanged: () => void | Promise<void>;
}

export function CharterDashboard({
	clubId,
	dashboard,
	onChanged,
}: CharterDashboardProps) {
	return (
		<div className="space-y-6">
			<div>
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
					{CHARTER_DASHBOARD_COPY.title}
				</h1>
				<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
					{dashboard
						? CHARTER_DASHBOARD_COPY.intro
						: CHARTER_DASHBOARD_COPY.chartered}
				</p>
			</div>
			<OfficialRequirementsNote />
			{dashboard ? (
				<>
					<TargetSection
						clubId={clubId}
						dashboard={dashboard}
						onChanged={onChanged}
					/>
					<ChecklistSection
						clubId={clubId}
						started={dashboard.started}
						steps={dashboard.steps}
						onChanged={onChanged}
					/>
					<HelpersSection
						clubId={clubId}
						dashboard={dashboard}
						onChanged={onChanged}
					/>
					<p className="text-sm">
						<Link to="/admin/club-settings" className="font-semibold underline">
							{CHARTER_DASHBOARD_COPY.markChartered}
						</Link>
					</p>
				</>
			) : null}
		</div>
	);
}

/** The progress bar, shared with the officer home card. */
export function CharterProgress({
	paid,
	needed,
}: {
	paid: number;
	needed: number;
}) {
	const pct = charterProgressPercent(paid, needed);
	return (
		<div className="space-y-1.5">
			<div
				data-testid="charter-progress-text"
				className="text-2xl font-semibold text-[var(--sea-ink)]"
			>
				{CHARTER_DASHBOARD_COPY.progress(paid, needed)}
			</div>
			<div
				role="progressbar"
				aria-valuemin={0}
				aria-valuemax={needed}
				aria-valuenow={paid}
				aria-label={CHARTER_DASHBOARD_COPY.target}
				className="h-2.5 w-full overflow-hidden rounded-full bg-[var(--line)]"
			>
				<div
					className="h-full rounded-full bg-[var(--lagoon-deep)]"
					style={{ width: `${pct}%` }}
				/>
			</div>
		</div>
	);
}

function TargetSection({
	clubId,
	dashboard,
	onChanged,
}: {
	clubId: string;
	dashboard: CharterDashboardData;
	onChanged: () => void | Promise<void>;
}) {
	const [needed, setNeeded] = useState(String(dashboard.membersNeeded));
	const [periodId, setPeriodId] = useState(dashboard.duesPeriodId ?? "");
	const { busy, run } = useCharterAction(onChanged);

	function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		// Only the fields this form changed, so saving one cannot revert the
		// other to what this tab loaded.
		const changed: { membersNeeded?: number; duesPeriodId?: string | null } =
			{};
		if (Number(needed) !== dashboard.membersNeeded) {
			changed.membersNeeded = Number(needed);
		}
		if ((periodId || null) !== dashboard.duesPeriodId) {
			changed.duesPeriodId = periodId || null;
		}
		if (Object.keys(changed).length === 0) return;
		void run(
			() => updateCharterTarget({ data: { clubId, ...changed } }),
			CHARTER_DASHBOARD_COPY.targetSaved,
		);
	}

	return (
		<section className={cardClass} aria-labelledby="charter-target-heading">
			<h2
				id="charter-target-heading"
				className="font-display text-xl font-semibold"
			>
				{CHARTER_DASHBOARD_COPY.target}
			</h2>
			<CharterProgress
				paid={dashboard.paidCount}
				needed={dashboard.membersNeeded}
			/>
			{dashboard.duesPeriodId === null ? (
				<p data-testid="charter-pick-period" className="text-sm">
					{dashboard.periods.length === 0
						? CHARTER_DASHBOARD_COPY.noPeriods
						: CHARTER_DASHBOARD_COPY.pickPeriod}{" "}
					<Link to="/admin/dues" className="font-semibold underline">
						{CHARTER_DASHBOARD_COPY.duesLink}
					</Link>
				</p>
			) : null}
			<form
				onSubmit={onSubmit}
				className="grid gap-3 sm:grid-cols-[10rem_1fr_auto] sm:items-end"
			>
				<div className="space-y-1.5">
					<Label htmlFor="charter-members-needed">
						{CHARTER_DASHBOARD_COPY.membersNeededLabel}
					</Label>
					<Input
						id="charter-members-needed"
						type="number"
						required
						min={MEMBERS_NEEDED_MIN}
						max={MEMBERS_NEEDED_MAX}
						value={needed}
						onChange={(e) => setNeeded(e.target.value)}
					/>
				</div>
				<div className="min-w-0 space-y-1.5">
					<Label htmlFor="charter-dues-period">
						{CHARTER_DASHBOARD_COPY.periodLabel}
					</Label>
					<select
						id="charter-dues-period"
						className={selectClass}
						value={periodId}
						onChange={(e) => setPeriodId(e.target.value)}
					>
						<option value="">{CHARTER_DASHBOARD_COPY.noPeriodOption}</option>
						{dashboard.periods.map((p) => (
							<option key={p.id} value={p.id}>
								{p.label}
							</option>
						))}
					</select>
				</div>
				<Button type="submit" disabled={busy} data-testid="save-target">
					{CHARTER_DASHBOARD_COPY.saveTarget}
				</Button>
			</form>
		</section>
	);
}

function ChecklistSection({
	clubId,
	started,
	steps,
	onChanged,
}: {
	clubId: string;
	/** False: `steps` are unpersisted defaults, shown read-only. */
	started: boolean;
	steps: CharterStep[];
	onChanged: () => void | Promise<void>;
}) {
	const [newLabel, setNewLabel] = useState("");
	const { busy, run } = useCharterAction(onChanged);

	const ids = steps.map((s) => s.id);
	const move = (id: string, direction: "up" | "down") =>
		run(() =>
			reorderCharterSteps({
				data: { clubId, stepIds: moveInOrder(ids, id, direction) },
			}),
		);

	return (
		<section className={cardClass} aria-labelledby="charter-checklist-heading">
			<div>
				<h2
					id="charter-checklist-heading"
					className="font-display text-xl font-semibold"
				>
					{CHARTER_DASHBOARD_COPY.checklist}
				</h2>
				<p className="text-sm text-[var(--sea-ink-soft)]">
					{CHARTER_DASHBOARD_COPY.checklistNote}
				</p>
			</div>
			{started ? null : (
				<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
					<p
						data-testid="charter-not-started"
						className="flex-1 text-sm text-[var(--sea-ink-soft)]"
					>
						{CHARTER_DASHBOARD_COPY.notStarted}
					</p>
					<Button
						type="button"
						data-testid="start-checklist"
						disabled={busy}
						onClick={() =>
							void run(() => startCharterChecklist({ data: { clubId } }))
						}
					>
						{CHARTER_DASHBOARD_COPY.startChecklist}
					</Button>
				</div>
			)}
			<ol className="space-y-2" data-testid="charter-steps">
				{steps.map((step, i) => (
					<StepRow
						key={step.id}
						clubId={clubId}
						step={step}
						first={i === 0}
						last={i === steps.length - 1}
						busy={busy || !started}
						run={run}
						onMove={(d) => move(step.id, d)}
					/>
				))}
			</ol>
			<form
				className="flex flex-col gap-2 sm:flex-row sm:items-end"
				onSubmit={(e) => {
					e.preventDefault();
					if (!newLabel.trim()) return;
					void run(async () => {
						await addCharterStep({ data: { clubId, label: newLabel } });
						setNewLabel("");
					});
				}}
			>
				<div className="min-w-0 flex-1 space-y-1.5">
					<Label htmlFor="charter-new-step">
						{CHARTER_DASHBOARD_COPY.addStepLabel}
					</Label>
					<Input
						id="charter-new-step"
						maxLength={CHARTER_STEP_LABEL_MAX}
						value={newLabel}
						onChange={(e) => setNewLabel(e.target.value)}
					/>
				</div>
				<Button type="submit" disabled={busy || !newLabel.trim()}>
					{CHARTER_DASHBOARD_COPY.addStep}
				</Button>
			</form>
		</section>
	);
}

function StepRow({
	clubId,
	step,
	first,
	last,
	busy,
	run,
	onMove,
}: {
	clubId: string;
	step: CharterStep;
	first: boolean;
	last: boolean;
	busy: boolean;
	run: (action: () => Promise<unknown>) => Promise<void>;
	onMove: (direction: "up" | "down") => void;
}) {
	const [label, setLabel] = useState(step.label);
	const labelId = useId();
	const dateId = useId();

	const saveLabel = () => {
		const next = label.trim();
		if (!next || next === step.label) {
			setLabel(step.label);
			return;
		}
		void run(() =>
			renameCharterStep({ data: { clubId, stepId: step.id, label: next } }),
		);
	};

	return (
		<li
			data-testid="charter-step"
			className="flex flex-col gap-2 rounded-lg border border-[var(--line)] p-3 sm:flex-row sm:items-end"
		>
			<div className="min-w-0 flex-1 space-y-1">
				<Label htmlFor={labelId} className="sr-only">
					Step name
				</Label>
				<Input
					id={labelId}
					maxLength={CHARTER_STEP_LABEL_MAX}
					value={label}
					disabled={busy}
					onChange={(e) => setLabel(e.target.value)}
					onBlur={saveLabel}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							saveLabel();
						}
					}}
					className={step.doneAt ? "line-through" : undefined}
				/>
			</div>
			<div className="space-y-1">
				<Label htmlFor={dateId} className="text-xs">
					{CHARTER_DASHBOARD_COPY.doneOnLabel(step.label)}
				</Label>
				<Input
					id={dateId}
					type="date"
					value={step.doneAt ?? ""}
					disabled={busy}
					onChange={(e) => {
						const value = e.target.value;
						void run(() =>
							setCharterStepDone({
								data: { clubId, stepId: step.id, doneAt: value || null },
							}),
						);
					}}
					className="max-w-[11rem]"
				/>
			</div>
			<div className="flex gap-1">
				<Button
					type="button"
					variant="outline"
					size="icon"
					aria-label={`Move ${step.label} up`}
					disabled={busy || first}
					onClick={() => onMove("up")}
				>
					<ArrowUp className="size-4" />
				</Button>
				<Button
					type="button"
					variant="outline"
					size="icon"
					aria-label={`Move ${step.label} down`}
					disabled={busy || last}
					onClick={() => onMove("down")}
				>
					<ArrowDown className="size-4" />
				</Button>
				<Button
					type="button"
					variant="outline"
					size="icon"
					aria-label={`Remove ${step.label}`}
					disabled={busy}
					onClick={() =>
						void run(() =>
							removeCharterStep({ data: { clubId, stepId: step.id } }),
						)
					}
				>
					<Trash2 className="size-4" />
				</Button>
			</div>
		</li>
	);
}

const OUTSIDE = "";

function HelpersSection({
	clubId,
	dashboard,
	onChanged,
}: {
	clubId: string;
	dashboard: CharterDashboardData;
	onChanged: () => void | Promise<void>;
}) {
	const [role, setRole] = useState<CharterHelperRole>("sponsor");
	const [personId, setPersonId] = useState(OUTSIDE);
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [phone, setPhone] = useState("");
	const [homeClub, setHomeClub] = useState("");
	const { busy, run } = useCharterAction(onChanged);
	const outside = personId === OUTSIDE;

	function onAdd(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		if (outside && !name.trim()) {
			toast.error(CHARTER_DASHBOARD_COPY.nameRequired);
			return;
		}
		void run(async () => {
			await addCharterHelper({
				data: outside
					? { clubId, role, personId: null, name, email, phone, homeClub }
					: { clubId, role, personId },
			});
			setPersonId(OUTSIDE);
			setName("");
			setEmail("");
			setPhone("");
			setHomeClub("");
		});
	}

	const onRemove = (helperId: string) =>
		run(() => removeCharterHelper({ data: { clubId, helperId } }));

	return (
		<section className={cardClass} aria-labelledby="charter-helpers-heading">
			<h2
				id="charter-helpers-heading"
				className="font-display text-xl font-semibold"
			>
				{CHARTER_DASHBOARD_COPY.helpers}
			</h2>
			{dashboard.helpers.length === 0 ? (
				<p className="text-sm text-[var(--sea-ink-soft)]">
					{CHARTER_DASHBOARD_COPY.noHelpers}
				</p>
			) : (
				<ul className="space-y-2" data-testid="charter-helpers">
					{dashboard.helpers.map((h) => (
						<li
							key={h.id}
							data-testid="charter-helper"
							className="flex items-start gap-3 rounded-lg border border-[var(--line)] p-3"
						>
							<div className="min-w-0 flex-1 text-sm">
								<div className="font-semibold text-[var(--sea-ink)]">
									{h.name}{" "}
									<span className="text-xs font-bold tracking-[0.04em] text-[var(--sea-ink-soft)] uppercase">
										{CHARTER_HELPER_ROLE_LABEL[h.role]}
									</span>
								</div>
								<div className="break-words text-[var(--sea-ink-soft)]">
									{[
										h.personId ? "On your roster" : h.homeClub,
										h.email,
										h.phone,
									]
										.filter(Boolean)
										.join(" · ")}
								</div>
							</div>
							<Button
								type="button"
								variant="outline"
								size="icon"
								aria-label={`Remove ${h.name}`}
								disabled={busy}
								onClick={() => void onRemove(h.id)}
							>
								<Trash2 className="size-4" />
							</Button>
						</li>
					))}
				</ul>
			)}
			<form onSubmit={onAdd} className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-1.5">
					<Label htmlFor="charter-helper-role">
						{CHARTER_DASHBOARD_COPY.roleLabel}
					</Label>
					<select
						id="charter-helper-role"
						className={selectClass}
						value={role}
						onChange={(e) => setRole(e.target.value as CharterHelperRole)}
					>
						{CHARTER_HELPER_ROLES.map((r) => (
							<option key={r} value={r}>
								{CHARTER_HELPER_ROLE_LABEL[r]}
							</option>
						))}
					</select>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="charter-helper-person">
						{CHARTER_DASHBOARD_COPY.fromRosterLabel}
					</Label>
					<select
						id="charter-helper-person"
						className={selectClass}
						value={personId}
						onChange={(e) => setPersonId(e.target.value)}
					>
						<option value={OUTSIDE}>
							{CHARTER_DASHBOARD_COPY.outsideOption}
						</option>
						{dashboard.people.map((p) => (
							<option key={p.personId} value={p.personId}>
								{p.name}
							</option>
						))}
					</select>
				</div>
				{outside ? (
					<>
						<HelperField
							id="charter-helper-name"
							label={CHARTER_DASHBOARD_COPY.nameLabel}
							value={name}
							onChange={setName}
						/>
						<HelperField
							id="charter-helper-email"
							label={CHARTER_DASHBOARD_COPY.emailLabel}
							type="email"
							value={email}
							onChange={setEmail}
						/>
						<HelperField
							id="charter-helper-phone"
							label={CHARTER_DASHBOARD_COPY.phoneLabel}
							type="tel"
							value={phone}
							onChange={setPhone}
						/>
						<HelperField
							id="charter-helper-home-club"
							label={CHARTER_DASHBOARD_COPY.homeClubLabel}
							value={homeClub}
							onChange={setHomeClub}
						/>
					</>
				) : null}
				<div className="sm:col-span-2">
					<Button type="submit" disabled={busy} data-testid="add-helper">
						{CHARTER_DASHBOARD_COPY.addHelper}
					</Button>
				</div>
			</form>
		</section>
	);
}

function HelperField({
	id,
	label,
	value,
	onChange,
	type = "text",
}: {
	id: string;
	label: string;
	value: string;
	onChange: (value: string) => void;
	type?: string;
}) {
	return (
		<div className="space-y-1.5">
			<Label htmlFor={id}>{label}</Label>
			<Input
				id={id}
				type={type}
				maxLength={CHARTER_HELPER_FIELD_MAX}
				value={value}
				onChange={(e) => onChange(e.target.value)}
			/>
		</div>
	);
}
