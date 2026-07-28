import { Loader2, Plus, X } from "lucide-react";
import { useState } from "react";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "#/components/ui/dialog";
import type {
	EnrollablePath,
	MemberEnrollment,
} from "#/server/path-enrollment";

/**
 * Declare which Pathways path(s) someone is on, without a Base Camp sync (#417).
 *
 * Presentational and controlled: the caller owns the server calls, because the
 * self surface and the admin surface hit different endpoints (the self one needs
 * no club, since `path_enrollments` is person-level). This component only knows
 * how to render the list and ask for a change.
 */
export function PathEnrollmentManager({
	enrollments,
	options,
	onAdd,
	onRemove,
	subject = "you",
}: {
	enrollments: MemberEnrollment[];
	options: EnrollablePath[];
	onAdd: (pathId: string) => Promise<void>;
	onRemove: (pathId: string) => Promise<void>;
	/** Whose paths these are, for copy. "you" (default) or a member's name. */
	subject?: string;
}) {
	const [open, setOpen] = useState(false);
	const [busyId, setBusyId] = useState<string | null>(null);

	const enrolledIds = new Set(enrollments.map((e) => e.pathId));
	const available = options.filter((o) => !enrolledIds.has(o.id));
	const current = available.filter((o) => o.status === "current");
	const legacy = available.filter((o) => o.status === "legacy");

	async function run(pathId: string, fn: (id: string) => Promise<void>) {
		setBusyId(pathId);
		try {
			await fn(pathId);
			setOpen(false);
		} finally {
			setBusyId(null);
		}
	}

	return (
		<div className="flex flex-col gap-2">
			{enrollments.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					{subject === "you"
						? "You haven't set a Pathways path yet."
						: `${subject} has no Pathways path set.`}
				</p>
			) : (
				<ul className="flex flex-col gap-1.5">
					{enrollments.map((e) => (
						<li
							key={e.pathId}
							className="flex items-center justify-between gap-2 rounded-md border border-[var(--line)] px-3 py-2"
						>
							<span className="flex min-w-0 items-center gap-2">
								<span className="truncate font-medium text-sm">{e.name}</span>
								{e.status === "legacy" ? (
									<Badge variant="outline" className="shrink-0 text-xs">
										Legacy
									</Badge>
								) : null}
								{/* Base Camp owns completion where it has spoken; saying so
								    makes the un-synced case read as "not yet", not "broken". */}
								{e.synced ? (
									<Badge variant="secondary" className="shrink-0 text-xs">
										Synced
									</Badge>
								) : null}
							</span>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								aria-label={`Remove ${e.name}`}
								disabled={busyId === e.pathId}
								onClick={() => run(e.pathId, onRemove)}
							>
								{busyId === e.pathId ? (
									<Loader2 className="size-4 animate-spin" aria-hidden />
								) : (
									<X className="size-4" aria-hidden />
								)}
							</Button>
						</li>
					))}
				</ul>
			)}

			<Dialog open={open} onOpenChange={setOpen}>
				<DialogTrigger asChild>
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="self-start"
					>
						<Plus className="size-4" aria-hidden />
						Add a path
					</Button>
				</DialogTrigger>
				<DialogContent className="max-h-[80vh] overflow-y-auto">
					<DialogHeader>
						<DialogTitle>Choose a path</DialogTitle>
					</DialogHeader>
					{available.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							Every path is already listed.
						</p>
					) : (
						<div className="flex flex-col gap-4">
							<PathGroup
								label="Current paths"
								paths={current}
								busyId={busyId}
								onPick={(id) => run(id, onAdd)}
							/>
							{/* Legacy paths are still selectable: members part-way through
							    one are real, and TI keeps them enrolled. */}
							<PathGroup
								label="Legacy paths"
								paths={legacy}
								busyId={busyId}
								onPick={(id) => run(id, onAdd)}
							/>
						</div>
					)}
				</DialogContent>
			</Dialog>
		</div>
	);
}

function PathGroup({
	label,
	paths,
	busyId,
	onPick,
}: {
	label: string;
	paths: EnrollablePath[];
	busyId: string | null;
	onPick: (pathId: string) => void;
}) {
	if (paths.length === 0) return null;
	return (
		<div className="flex flex-col gap-1.5">
			<div className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
				{label}
			</div>
			{paths.map((p) => (
				<Button
					key={p.id}
					type="button"
					variant="ghost"
					className="h-auto justify-start px-3 py-2 text-left"
					disabled={busyId !== null}
					onClick={() => onPick(p.id)}
				>
					{busyId === p.id ? (
						<Loader2 className="size-4 animate-spin" aria-hidden />
					) : null}
					{p.name}
				</Button>
			))}
		</div>
	);
}
