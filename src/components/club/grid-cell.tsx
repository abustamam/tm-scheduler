import { Link } from "@tanstack/react-router";
import type { ViewCell } from "#/lib/season-grid-view";
import { cn } from "#/lib/utils";

const KIND_CLASS: Record<ViewCell["kind"], string> = {
	assigned: "bg-emerald-600 text-white",
	open: "border border-dashed border-amber-500/60 text-amber-600",
	free: "border border-border text-muted-foreground/60",
	na: "border border-dashed border-rose-500/60 text-rose-600",
	blank: "opacity-0",
};

export function GridCell({ cell }: { cell: ViewCell }) {
	const inner = (
		<span
			title={cell.title || undefined}
			className={cn(
				"flex h-8 min-w-[3rem] items-center justify-center rounded-md px-2 text-xs font-semibold",
				KIND_CLASS[cell.kind],
			)}
		>
			{cell.text}
		</span>
	);
	if (cell.kind === "blank") return inner;
	return (
		<Link
			to="/meetings/$id"
			params={{ id: cell.meetingId }}
			className="block"
			aria-label={cell.title || "meeting"}
		>
			{inner}
		</Link>
	);
}
