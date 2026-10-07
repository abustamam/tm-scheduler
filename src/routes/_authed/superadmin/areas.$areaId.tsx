import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ArrowLeft, Link2, Loader2, Plus, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PageContainer } from "#/components/page-container";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { CLUB_NUMBER_MAX, CLUB_NUMBER_PATTERN } from "#/lib/club-charter";
import { programYearLabel } from "#/lib/dcp";
import {
	addAreaClub,
	assignAreaDirector,
	endAreaDirectorTerm,
	findUserForDirector,
	getConsoleArea,
	linkAreaClub,
	removeAreaClub,
	renameArea,
	renameDivision,
} from "#/server/areas";
import type { ConsoleAreaDetail } from "#/server/areas-logic";

export const Route = createFileRoute("/_authed/superadmin/areas/$areaId")({
	loader: ({ params }) => getConsoleArea({ data: { areaId: params.areaId } }),
	component: AreaDetail,
});

// Pinned to UTC (#1017). With no zone this printed the RUNTIME's day, so the
// UTC server and a browser in Tokyo disagreed and React threw the server markup
// away. The terms are `timestamp`s with no zone of their own.
const dateFmt = new Intl.DateTimeFormat("en-US", {
	year: "numeric",
	month: "short",
	day: "numeric",
	timeZone: "UTC",
});

/** Matches `selectClass` in the superadmin console's club form. */
const selectClass =
	"flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

const panelClass =
	"space-y-3 rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] p-4";

type Area = ConsoleAreaDetail;

/** Runs `action`, toasts its refusal, and reports whether it went through. */
async function run(
	setBusy: (busy: boolean) => void,
	action: () => Promise<unknown>,
	success: string,
): Promise<boolean> {
	setBusy(true);
	try {
		await action();
		toast.success(success);
		return true;
	} catch (err) {
		toast.error(err instanceof Error ? err.message : "That didn't work.");
		return false;
	} finally {
		setBusy(false);
	}
}

function AreaDetail() {
	const area = Route.useLoaderData();
	const router = useRouter();
	const refresh = () => router.invalidate();

	return (
		<PageContainer className="space-y-6">
			<div className="space-y-1">
				<Link
					to="/superadmin/areas"
					className="inline-flex items-center gap-1 text-sm text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]"
				>
					<ArrowLeft className="size-4" /> All areas
				</Link>
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
					Area {area.label}
				</h1>
				<p className="text-sm text-muted-foreground">
					District {area.districtNumber} · Division {area.divisionLetter} ·{" "}
					{area.programYearLabel}
				</p>
			</div>

			<ClubsPanel area={area} onChanged={refresh} />
			<DirectorPanel area={area} onChanged={refresh} />
			<RelabelPanel area={area} onChanged={refresh} />
		</PageContainer>
	);
}

function ClubsPanel({
	area,
	onChanged,
}: {
	area: Area;
	onChanged: () => void;
}) {
	const [busyId, setBusyId] = useState<string | null>(null);

	async function act(
		rowId: string,
		action: () => Promise<unknown>,
		success: string,
	) {
		const ok = await run((b) => setBusyId(b ? rowId : null), action, success);
		if (ok) onChanged();
	}

	return (
		<section className={panelClass}>
			<h2 className="text-sm font-bold">Clubs ({area.clubs.length})</h2>
			{area.clubs.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					No clubs in this area yet.
				</p>
			) : (
				<ul className="divide-y divide-[var(--line)]">
					{area.clubs.map((club) => (
						<li
							key={club.id}
							className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
						>
							<div className="space-y-0.5">
								{club.clubId ? (
									<Link
										to="/superadmin/$clubId"
										params={{ clubId: club.clubId }}
										className="font-medium text-[var(--palm)] underline-offset-2 hover:underline"
									>
										{club.name}
									</Link>
								) : (
									<span className="font-medium">
										{club.name}
										<span className="ml-2 inline-block rounded-full bg-[var(--sand)] px-2 py-0.5 text-xs font-semibold text-[var(--sea-ink-soft)] uppercase tracking-[0.04em]">
											Not on GavelUp
										</span>
									</span>
								)}
								<p className="text-xs text-[var(--sea-ink-soft)]">
									Club {club.clubNumber ?? "—"} · {club.visitCount} visit
									{club.visitCount === 1 ? "" : "s"} recorded
								</p>
							</div>
							<div className="flex flex-wrap items-center gap-2">
								{club.linkOffer ? (
									<Button
										type="button"
										size="sm"
										variant="outline"
										disabled={busyId === club.id}
										onClick={() =>
											act(
												club.id,
												() => linkAreaClub({ data: { areaClubId: club.id } }),
												"Linked.",
											)
										}
									>
										<Link2 className="size-4" /> Link to {club.linkOffer.name}
									</Button>
								) : null}
								<Button
									type="button"
									size="sm"
									variant="outline"
									disabled={busyId === club.id || club.visitCount > 0}
									title={
										club.visitCount > 0
											? "This club has recorded visits"
											: undefined
									}
									onClick={() =>
										act(
											club.id,
											() => removeAreaClub({ data: { areaClubId: club.id } }),
											"Removed.",
										)
									}
								>
									<Trash2 className="size-4" /> Remove
								</Button>
							</div>
						</li>
					))}
				</ul>
			)}
			<AddGavelUpClubForm area={area} onAdded={onChanged} />
			<AddNameOnlyClubForm areaId={area.id} onAdded={onChanged} />
		</section>
	);
}

function AddGavelUpClubForm({
	area,
	onAdded,
}: {
	area: Area;
	onAdded: () => void;
}) {
	const [busy, setBusy] = useState(false);

	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const el = e.currentTarget;
		const form = new FormData(el);
		const ok = await run(
			setBusy,
			() =>
				addAreaClub({
					data: {
						areaId: area.id,
						clubId: String(form.get("clubId") ?? ""),
					},
				}),
			"Club added.",
		);
		if (ok) {
			el.reset();
			onAdded();
		}
	}

	return (
		<form
			onSubmit={onSubmit}
			className="flex flex-wrap items-end gap-3 border-t border-dashed border-[var(--line)] pt-3"
		>
			<div className="min-w-48 flex-1 space-y-1.5">
				<Label htmlFor="gavelupClub">Add a GavelUp club</Label>
				<select
					id="gavelupClub"
					name="clubId"
					required
					className={selectClass}
					defaultValue=""
				>
					<option value="" disabled>
						{area.availableClubs.length === 0
							? `Every club is in an area for ${area.programYearLabel}`
							: "Choose a club"}
					</option>
					{area.availableClubs.map((c) => (
						<option key={c.id} value={c.id}>
							{c.name}
							{c.clubNumber ? ` (${c.clubNumber})` : ""}
						</option>
					))}
				</select>
			</div>
			<Button type="submit" size="sm" disabled={busy}>
				{busy ? (
					<Loader2 className="size-4 animate-spin" />
				) : (
					<>
						<Plus className="size-4" /> Add club
					</>
				)}
			</Button>
		</form>
	);
}

function AddNameOnlyClubForm({
	areaId,
	onAdded,
}: {
	areaId: string;
	onAdded: () => void;
}) {
	const [busy, setBusy] = useState(false);

	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const el = e.currentTarget;
		const form = new FormData(el);
		const ok = await run(
			setBusy,
			() =>
				addAreaClub({
					data: {
						areaId,
						name: String(form.get("clubName") ?? ""),
						clubNumber: String(form.get("clubNumber") ?? ""),
					},
				}),
			"Club added.",
		);
		if (ok) {
			el.reset();
			onAdded();
		}
	}

	return (
		<form
			onSubmit={onSubmit}
			className="flex flex-wrap items-end gap-3 border-t border-dashed border-[var(--line)] pt-3"
		>
			<div className="min-w-48 flex-1 space-y-1.5">
				<Label htmlFor="nameOnlyClubName">A club not on GavelUp</Label>
				<Input
					id="nameOnlyClubName"
					name="clubName"
					required
					maxLength={120}
					placeholder="Club name"
				/>
			</div>
			<div className="w-40 space-y-1.5">
				<Label htmlFor="nameOnlyClubNumber">Club number (optional)</Label>
				<Input
					id="nameOnlyClubNumber"
					name="clubNumber"
					inputMode="numeric"
					pattern={CLUB_NUMBER_PATTERN}
					maxLength={CLUB_NUMBER_MAX}
					placeholder="e.g. 1234567"
				/>
			</div>
			<Button type="submit" size="sm" disabled={busy}>
				{busy ? (
					<Loader2 className="size-4 animate-spin" />
				) : (
					<>
						<Plus className="size-4" /> Add by name
					</>
				)}
			</Button>
		</form>
	);
}

function DirectorPanel({
	area,
	onChanged,
}: {
	area: Area;
	onChanged: () => void;
}) {
	const [ending, setEnding] = useState(false);
	const director = area.director;
	// A past year's area is history: nobody is assigned to it any more.
	const canAssign = !director && area.programYear >= area.currentProgramYear;

	async function endTerm(termId: string) {
		const ok = await run(
			setEnding,
			() => endAreaDirectorTerm({ data: { termId } }),
			"Term ended.",
		);
		if (ok) onChanged();
	}

	return (
		<section className={panelClass}>
			<h2 className="text-sm font-bold">Area Director</h2>
			{director ? (
				<div className="flex flex-wrap items-center justify-between gap-2 text-sm">
					<div>
						<p className="font-medium">{director.displayName}</p>
						<p className="text-xs text-[var(--sea-ink-soft)]">
							{director.email} · since{" "}
							{dateFmt.format(new Date(director.startedAt))}
							{director.state === "upcoming"
								? ` · takes effect with ${area.programYearLabel}`
								: ""}
							{director.state === "ended-with-year"
								? ` · ended with ${area.programYearLabel}`
								: ""}
						</p>
					</div>
					{director.state === "ended-with-year" ? null : (
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={ending}
							onClick={() => endTerm(director.id)}
						>
							{ending ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								"End term"
							)}
						</Button>
					)}
				</div>
			) : (
				<p className="text-sm text-muted-foreground">
					No Area Director for {area.programYearLabel}.
				</p>
			)}

			{canAssign ? (
				<AssignDirectorForm areaId={area.id} onAssigned={onChanged} />
			) : null}

			{area.pastTerms.length > 0 ? (
				<div className="space-y-1.5 border-t border-dashed border-[var(--line)] pt-3">
					<h3 className="text-xs font-semibold text-[var(--sea-ink-soft)]">
						Past terms
					</h3>
					<ul className="space-y-1 text-sm">
						{area.pastTerms.map((term) => (
							<li key={term.id}>
								{term.displayName}{" "}
								<span className="text-[var(--sea-ink-soft)]">
									· {term.email} · {dateFmt.format(new Date(term.startedAt))} to{" "}
									{term.endedAt ? dateFmt.format(new Date(term.endedAt)) : "—"}
								</span>
							</li>
						))}
					</ul>
				</div>
			) : null}
		</section>
	);
}

function AssignDirectorForm({
	areaId,
	onAssigned,
}: {
	areaId: string;
	onAssigned: () => void;
}) {
	const [email, setEmail] = useState("");
	// undefined: not looked up yet. null: looked up, no verified account.
	const [found, setFound] = useState<{ id: string; email: string } | null>();
	const [looking, setLooking] = useState(false);
	const [assigning, setAssigning] = useState(false);

	async function lookUp(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		setLooking(true);
		try {
			setFound(await findUserForDirector({ data: { email } }));
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "That didn't work.");
		} finally {
			setLooking(false);
		}
	}

	async function assign(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		if (!found) return;
		const displayName = String(
			new FormData(e.currentTarget).get("displayName") ?? "",
		);
		const ok = await run(
			setAssigning,
			() =>
				assignAreaDirector({
					data: { areaId, userId: found.id, displayName },
				}),
			"Area Director assigned.",
		);
		if (ok) {
			setEmail("");
			setFound(undefined);
			onAssigned();
		}
	}

	return (
		<div className="space-y-3 border-t border-dashed border-[var(--line)] pt-3">
			<form onSubmit={lookUp} className="flex flex-wrap items-end gap-3">
				<div className="min-w-48 flex-1 space-y-1.5">
					<Label htmlFor="directorEmail">Find the Area Director by email</Label>
					<Input
						id="directorEmail"
						type="email"
						required
						value={email}
						onChange={(e) => {
							setEmail(e.target.value);
							setFound(undefined);
						}}
						placeholder="name@example.com"
					/>
				</div>
				<Button type="submit" size="sm" variant="outline" disabled={looking}>
					{looking ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						<>
							<Search className="size-4" /> Find
						</>
					)}
				</Button>
			</form>
			{found === null ? (
				<p className="text-sm text-muted-foreground">
					No account with that exact, verified email. They sign in to GavelUp
					once first.
				</p>
			) : null}
			{found ? (
				<form onSubmit={assign} className="flex flex-wrap items-end gap-3">
					<div className="min-w-48 flex-1 space-y-1.5">
						<Label htmlFor="directorDisplayName">
							Name shown to the club's admins
						</Label>
						<Input
							id="directorDisplayName"
							name="displayName"
							required
							maxLength={120}
							placeholder="e.g. Jamie Rivera"
						/>
						<p className="text-xs text-muted-foreground">
							Account: {found.email}
						</p>
					</div>
					<Button type="submit" size="sm" disabled={assigning}>
						{assigning ? (
							<Loader2 className="size-4 animate-spin" />
						) : (
							"Make Area Director"
						)}
					</Button>
				</form>
			) : null}
		</div>
	);
}

/** Fix a typo in the division letter or the area number. The chain is not
 *  moved: no fn changes an area's division, or a division's district or year. */
function RelabelPanel({
	area,
	onChanged,
}: {
	area: Area;
	onChanged: () => void;
}) {
	const [busy, setBusy] = useState(false);

	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const form = new FormData(e.currentTarget);
		const letter = String(form.get("divisionLetter") ?? "").trim();
		const number = String(form.get("areaNumber") ?? "").trim();
		const ok = await run(
			setBusy,
			async () => {
				if (letter !== area.divisionLetter) {
					await renameDivision({
						data: { divisionId: area.divisionId, letter },
					});
				}
				if (number !== area.number) {
					await renameArea({ data: { areaId: area.id, number } });
				}
			},
			"Saved.",
		);
		if (ok) onChanged();
	}

	return (
		<form onSubmit={onSubmit} className={panelClass}>
			<h2 className="text-sm font-bold">Fix the label</h2>
			<p className="text-xs text-muted-foreground">
				Division {area.divisionLetter} is shared by every area in it, for{" "}
				{programYearLabel(area.programYear)}.
			</p>
			<div className="grid max-w-sm gap-3 sm:grid-cols-2">
				<div className="space-y-1.5">
					<Label htmlFor="relabelLetter">Division letter</Label>
					<Input
						id="relabelLetter"
						name="divisionLetter"
						required
						maxLength={4}
						defaultValue={area.divisionLetter}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="relabelNumber">Area number</Label>
					<Input
						id="relabelNumber"
						name="areaNumber"
						required
						maxLength={4}
						defaultValue={area.number}
					/>
				</div>
			</div>
			<Button type="submit" size="sm" variant="outline" disabled={busy}>
				{busy ? <Loader2 className="size-4 animate-spin" /> : "Save"}
			</Button>
		</form>
	);
}
