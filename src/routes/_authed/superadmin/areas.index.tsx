import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ArrowLeft, Loader2, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PageContainer } from "#/components/page-container";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { programYearLabel } from "#/lib/dcp";
import {
	createArea,
	createDistrict,
	createDivision,
	listConsoleAreas,
} from "#/server/areas";
import type { ConsoleAreaListDistrict } from "#/server/areas-logic";

export const Route = createFileRoute("/_authed/superadmin/areas/")({
	loader: () => listConsoleAreas(),
	component: AreasConsole,
});

/** Matches `selectClass` in the superadmin console's club form — the shadcn
 *  Input's box on a native `<select>` (there is no shadcn select primitive). */
const selectClass =
	"flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

function AreasConsole() {
	const { districts, currentProgramYear } = Route.useLoaderData();
	const router = useRouter();
	const refresh = () => router.invalidate();

	return (
		<PageContainer className="space-y-6">
			<div className="space-y-1">
				<Link
					to="/superadmin"
					className="inline-flex items-center gap-1 text-sm text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]"
				>
					<ArrowLeft className="size-4" /> All clubs
				</Link>
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
					Areas
				</h1>
				<p className="text-sm text-muted-foreground">
					Districts, their divisions and areas for each program year, the clubs
					in every area and the Area Director who visits them. A division
					belongs to one program year; a new year is new divisions and areas,
					and last year's stay as they were.
				</p>
			</div>

			<div className="grid gap-4 md:grid-cols-3">
				<CreateDistrictForm onCreated={refresh} />
				<CreateDivisionForm
					districts={districts}
					currentProgramYear={currentProgramYear}
					onCreated={refresh}
				/>
				<CreateAreaForm districts={districts} onCreated={refresh} />
			</div>

			{districts.length === 0 ? (
				<p className="text-sm text-muted-foreground">No districts yet.</p>
			) : (
				districts.map((district) => (
					<section key={district.id} className="space-y-3">
						<h2 className="text-sm font-bold">District {district.number}</h2>
						{district.divisions.length === 0 ? (
							<p className="text-sm text-muted-foreground">No divisions yet.</p>
						) : (
							<div className="space-y-3">
								{district.divisions.map((division) => (
									<div
										key={division.id}
										className="space-y-2 rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] p-4"
									>
										<h3 className="text-sm font-semibold">
											Division {division.letter}{" "}
											<span className="font-normal text-[var(--sea-ink-soft)]">
												· {division.programYearLabel}
											</span>
										</h3>
										{division.areas.length === 0 ? (
											<p className="text-sm text-muted-foreground">
												No areas yet.
											</p>
										) : (
											<ul className="divide-y divide-[var(--line)]">
												{division.areas.map((area) => (
													<li
														key={area.id}
														className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
													>
														<Link
															to="/superadmin/areas/$areaId"
															params={{ areaId: area.id }}
															className="font-medium text-[var(--palm)] underline-offset-2 hover:underline"
														>
															Area {area.label}
														</Link>
														<span className="text-[var(--sea-ink-soft)]">
															{area.clubCount} club
															{area.clubCount === 1 ? "" : "s"}
															{" · "}
															{area.directorCount > 0
																? "Area Director assigned"
																: "No Area Director"}
														</span>
													</li>
												))}
											</ul>
										)}
									</div>
								))}
							</div>
						)}
					</section>
				))
			)}
		</PageContainer>
	);
}

type ListDistrict = ConsoleAreaListDistrict;

/** Runs `action`, toasts its refusal, and reports whether it went through. */
async function submit(
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

function SubmitButton({ busy, label }: { busy: boolean; label: string }) {
	return (
		<Button type="submit" size="sm" disabled={busy} className="ml-auto">
			{busy ? (
				<Loader2 className="size-4 animate-spin" />
			) : (
				<>
					<Plus className="size-4" /> {label}
				</>
			)}
		</Button>
	);
}

const formClass =
	"space-y-3 rounded-xl border border-dashed border-[var(--line)] bg-[var(--foam)] p-4";

function CreateDistrictForm({ onCreated }: { onCreated: () => void }) {
	const [busy, setBusy] = useState(false);

	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const el = e.currentTarget;
		const form = new FormData(el);
		const ok = await submit(
			setBusy,
			() =>
				createDistrict({
					data: { number: String(form.get("districtNumber") ?? "") },
				}),
			"District added.",
		);
		if (ok) {
			el.reset();
			onCreated();
		}
	}

	return (
		<form onSubmit={onSubmit} className={formClass}>
			<h2 className="text-sm font-bold">Add a district</h2>
			<div className="space-y-1.5">
				<Label htmlFor="districtNumber">District number</Label>
				<Input
					id="districtNumber"
					name="districtNumber"
					required
					maxLength={8}
					placeholder="e.g. 39"
				/>
			</div>
			<div className="flex items-center">
				<SubmitButton busy={busy} label="Add district" />
			</div>
		</form>
	);
}

function CreateDivisionForm({
	districts,
	currentProgramYear,
	onCreated,
}: {
	districts: ListDistrict[];
	currentProgramYear: number;
	onCreated: () => void;
}) {
	const [busy, setBusy] = useState(false);
	// A division's year is this program year or the next, the same two the
	// server accepts; the loader names the current one so the server and the
	// browser agree on it across July 1.
	const years = [currentProgramYear, currentProgramYear + 1];

	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const el = e.currentTarget;
		const form = new FormData(el);
		const ok = await submit(
			setBusy,
			() =>
				createDivision({
					data: {
						districtId: String(form.get("districtId") ?? ""),
						programYear: Number(form.get("programYear")),
						letter: String(form.get("divisionLetter") ?? ""),
					},
				}),
			"Division added.",
		);
		if (ok) {
			el.reset();
			onCreated();
		}
	}

	return (
		<form onSubmit={onSubmit} className={formClass}>
			<h2 className="text-sm font-bold">Add a division</h2>
			<div className="space-y-1.5">
				<Label htmlFor="divisionDistrict">District</Label>
				<select
					id="divisionDistrict"
					name="districtId"
					required
					className={selectClass}
					defaultValue=""
				>
					<option value="" disabled>
						Choose a district
					</option>
					{districts.map((d) => (
						<option key={d.id} value={d.id}>
							District {d.number}
						</option>
					))}
				</select>
			</div>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-1.5">
					<Label htmlFor="divisionYear">Program year</Label>
					<select
						id="divisionYear"
						name="programYear"
						className={selectClass}
						defaultValue={currentProgramYear}
					>
						{years.map((y) => (
							<option key={y} value={y}>
								{programYearLabel(y)}
							</option>
						))}
					</select>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="divisionLetter">Division letter</Label>
					<Input
						id="divisionLetter"
						name="divisionLetter"
						required
						maxLength={4}
						placeholder="e.g. C"
					/>
				</div>
			</div>
			<div className="flex items-center">
				<SubmitButton busy={busy} label="Add division" />
			</div>
		</form>
	);
}

function CreateAreaForm({
	districts,
	onCreated,
}: {
	districts: ListDistrict[];
	onCreated: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const divisions = districts.flatMap((d) =>
		d.divisions.map((division) => ({ district: d, division })),
	);

	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const el = e.currentTarget;
		const form = new FormData(el);
		const ok = await submit(
			setBusy,
			() =>
				createArea({
					data: {
						divisionId: String(form.get("divisionId") ?? ""),
						number: String(form.get("areaNumber") ?? ""),
					},
				}),
			"Area added.",
		);
		if (ok) {
			el.reset();
			onCreated();
		}
	}

	return (
		<form onSubmit={onSubmit} className={formClass}>
			<h2 className="text-sm font-bold">Add an area</h2>
			<div className="space-y-1.5">
				<Label htmlFor="areaDivision">Division</Label>
				<select
					id="areaDivision"
					name="divisionId"
					required
					className={selectClass}
					defaultValue=""
				>
					<option value="" disabled>
						Choose a division
					</option>
					{divisions.map(({ district, division }) => (
						<option key={division.id} value={division.id}>
							District {district.number} · Division {division.letter} ·{" "}
							{division.programYearLabel}
						</option>
					))}
				</select>
			</div>
			<div className="space-y-1.5">
				<Label htmlFor="areaNumber">Area number</Label>
				<Input
					id="areaNumber"
					name="areaNumber"
					required
					maxLength={4}
					placeholder="e.g. 3"
				/>
			</div>
			<div className="flex items-center">
				<SubmitButton busy={busy} label="Add area" />
			</div>
		</form>
	);
}
