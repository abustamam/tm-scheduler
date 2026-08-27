import { Check, ChevronDown, X } from "lucide-react";
import { useMemo, useState } from "react";
import { EvaluationResourceLinks } from "#/components/pathways/evaluation-resource-link";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { levelLabel } from "#/lib/pathways-catalog";
import type { PickerPath, PickerProject } from "#/server/project-picker";

/**
 * Pick a real Pathways project instead of typing path/project/level (#418).
 *
 * Controlled and presentational — the two call sites (claiming a speaker slot,
 * editing an existing speech) own their own form plumbing.
 *
 * Degrades to the ORIGINAL three free-text inputs when the speaker has no
 * declared path (#417) or their club's catalog is empty. That is the common
 * case on day one, and a picker with nothing in it would be a dead end where
 * there used to be a working form.
 */
export function ProjectPicker({
	paths,
	value,
	onChange,
	fallback,
}: {
	paths: PickerPath[];
	/** Selected `pathways_projects.id`, or null for none / free text. */
	value: string | null;
	onChange: (projectId: string | null) => void;
	/** Current free-text values, used when no path is declared. */
	fallback: {
		pathwayPath: string | null;
		projectName: string | null;
		projectLevel: string | null;
	};
}) {
	const [open, setOpen] = useState(false);
	const [manual, setManual] = useState(false);

	const selected = useMemo(() => {
		if (!value) return null;
		for (const path of paths) {
			const project = path.projects.find((p) => p.id === value);
			if (project) return { path, project };
		}
		return null;
	}, [paths, value]);

	// No declared path (or an unseeded catalog) — the form works exactly as it
	// did before this feature existed.
	if (paths.length === 0) {
		return <FreeTextFields fallback={fallback} note="noPath" />;
	}

	if (manual) {
		return (
			<div className="space-y-2">
				<FreeTextFields fallback={fallback} note={null} />
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() => setManual(false)}
				>
					Pick from my path instead
				</Button>
			</div>
		);
	}

	return (
		<div className="space-y-2">
			<Label htmlFor="project-picker-trigger">Pathways project</Label>
			<div className="flex items-center gap-2">
				<Button
					id="project-picker-trigger"
					type="button"
					variant="outline"
					className="h-auto min-h-9 flex-1 justify-between gap-2 px-3 py-2 text-left font-normal"
					onClick={() => setOpen(true)}
				>
					{selected ? (
						<span className="flex min-w-0 flex-col">
							<span className="truncate font-medium">
								{selected.project.name}
							</span>
							<span className="truncate text-muted-foreground text-xs">
								{selected.path.name} · {levelLabel(selected.project.level)}
							</span>
						</span>
					) : (
						<span className="text-muted-foreground">Choose a project</span>
					)}
					<ChevronDown className="size-4 shrink-0 opacity-50" aria-hidden />
				</Button>
				{selected ? (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						aria-label="Clear project"
						onClick={() => onChange(null)}
					>
						<X className="size-4" aria-hidden />
					</Button>
				) : null}
			</div>
			{selected ? (
				<EvaluationResourceLinks projectName={selected.project.name} />
			) : null}
			<Button
				type="button"
				variant="ghost"
				size="sm"
				className="h-auto p-0 text-muted-foreground text-xs"
				onClick={() => setManual(true)}
			>
				Not a Pathways project — type it instead
			</Button>

			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Choose a project</DialogTitle>
					</DialogHeader>
					<div className="flex flex-col gap-5">
						{paths.map((path) => (
							<PathSection
								key={path.pathId}
								path={path}
								selectedId={value}
								showPathName={paths.length > 1}
								onPick={(id) => {
									onChange(id);
									setOpen(false);
								}}
							/>
						))}
					</div>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function PathSection({
	path,
	selectedId,
	showPathName,
	onPick,
}: {
	path: PickerPath;
	selectedId: string | null;
	showPathName: boolean;
	onPick: (projectId: string) => void;
}) {
	// Every level is reachable; the default only decides what's already open.
	// Members work ahead (Level 1 finished but unapproved, already delivering
	// Level 2) and behind (repeating an elective), so nothing here is a gate.
	const selectedLevel = path.projects.find((p) => p.id === selectedId)?.level;
	const [openLevels, setOpenLevels] = useState<Set<number>>(
		() => new Set([selectedLevel ?? path.defaultLevel]),
	);

	const levels = useMemo(() => {
		const byLevel = new Map<number, PickerProject[]>();
		for (const p of path.projects) {
			const list = byLevel.get(p.level);
			if (list) list.push(p);
			else byLevel.set(p.level, [p]);
		}
		return [...byLevel.entries()].sort((a, b) => a[0] - b[0]);
	}, [path.projects]);

	function toggle(level: number) {
		setOpenLevels((prev) => {
			const next = new Set(prev);
			if (next.has(level)) next.delete(level);
			else next.add(level);
			return next;
		});
	}

	return (
		<div className="flex flex-col gap-2">
			{showPathName ? (
				<div className="flex items-center gap-2">
					<span className="font-medium text-sm">{path.name}</span>
					{path.status === "legacy" ? (
						<Badge variant="outline" className="text-xs">
							Legacy
						</Badge>
					) : null}
				</div>
			) : null}
			{levels.map(([level, projects]) => {
				const isOpen = openLevels.has(level);
				return (
					<div key={level} className="rounded-md border border-[var(--line)]">
						<button
							type="button"
							className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
							onClick={() => toggle(level)}
							aria-expanded={isOpen}
						>
							<span className="font-medium text-sm">{levelLabel(level)}</span>
							<ChevronDown
								className={`size-4 opacity-50 transition-transform ${
									isOpen ? "rotate-180" : ""
								}`}
								aria-hidden
							/>
						</button>
						{isOpen ? (
							<ul className="border-[var(--line)] border-t">
								{projects.map((project) => (
									<li key={project.id}>
										<button
											type="button"
											className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted ${
												project.id === selectedId ? "bg-muted" : ""
											}`}
											onClick={() => onPick(project.id)}
										>
											{/* Completed projects stay SELECTABLE — repeats are
											    real, which is why path_level_progress.completed
											    may exceed total. The tick informs, it doesn't
											    disable. */}
											<Check
												className={`size-4 shrink-0 ${
													project.complete ? "text-primary" : "invisible"
												}`}
												aria-hidden
											/>
											<span className="min-w-0 flex-1 truncate">
												{project.name}
											</span>
											{project.isRequired ? (
												<Badge
													variant="secondary"
													className="shrink-0 text-[10px]"
												>
													Required
												</Badge>
											) : null}
											{project.complete ? (
												<span className="sr-only">(completed)</span>
											) : null}
										</button>
										<div className="px-3 pb-2 pl-9">
											<EvaluationResourceLinks projectName={project.name} />
										</div>
									</li>
								))}
							</ul>
						) : null}
					</div>
				);
			})}
		</div>
	);
}

/** The pre-#418 inputs, kept verbatim so the no-path case loses nothing. */
function FreeTextFields({
	fallback,
	note,
}: {
	fallback: {
		pathwayPath: string | null;
		projectName: string | null;
		projectLevel: string | null;
	};
	note: "noPath" | null;
}) {
	return (
		<>
			<div className="space-y-2">
				<Label htmlFor="pathwayPath">Pathways path</Label>
				<Input
					id="pathwayPath"
					name="pathwayPath"
					defaultValue={fallback.pathwayPath ?? ""}
					placeholder="e.g. Presentation Mastery"
				/>
				{note === "noPath" ? (
					<p className="text-muted-foreground text-xs">
						Set your Pathways path on your dashboard to pick projects from the
						real catalog.
					</p>
				) : null}
			</div>
			<div className="grid grid-cols-2 gap-3">
				<div className="space-y-2">
					<Label htmlFor="projectName">Project</Label>
					<Input
						id="projectName"
						name="projectName"
						defaultValue={fallback.projectName ?? ""}
						placeholder="Ice Breaker"
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="projectLevel">Level</Label>
					<Input
						id="projectLevel"
						name="projectLevel"
						defaultValue={fallback.projectLevel ?? ""}
						placeholder="Level 1"
					/>
				</div>
			</div>
		</>
	);
}
