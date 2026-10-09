import { Loader2 } from "lucide-react";
import { useState } from "react";
import { AreaHealthView } from "#/components/area/area-health-view";
import { Button } from "#/components/ui/button";
import type { AreaHealth } from "#/lib/area-health";
import { previewConsoleArea } from "#/server/areas";

type Preview =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "ready"; health: AreaHealth }
	| { status: "failed"; message: string };

/**
 * "Preview as Area Director" on the superadmin console's area page (#1119): the
 * numbers the area's director sees, rendered by the same view.
 *
 * Read on demand, not with the page: computing six counts for every club is
 * work the console's ordinary visit should not pay. A superadmin is refused by
 * the director's own read (`getAreaHealth`, ADR-0016 section 4), so this goes
 * through `previewConsoleArea`, which checks `requireSuperadmin` instead.
 */
export function AreaPreviewPanel({ areaId }: { areaId: string }) {
	const [preview, setPreview] = useState<Preview>({ status: "idle" });

	async function load() {
		setPreview({ status: "loading" });
		try {
			const health = await previewConsoleArea({ data: { areaId } });
			setPreview({ status: "ready", health });
		} catch (err) {
			setPreview({
				status: "failed",
				message: err instanceof Error ? err.message : "That didn't work.",
			});
		}
	}

	return (
		<section className="space-y-3 rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] p-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h2 className="text-sm font-bold">Preview as Area Director</h2>
				<Button
					type="button"
					size="sm"
					variant="outline"
					onClick={load}
					disabled={preview.status === "loading"}
				>
					{preview.status === "loading" ? (
						<Loader2 className="size-4 animate-spin" aria-hidden />
					) : null}
					{preview.status === "ready" ? "Refresh preview" : "Show preview"}
				</Button>
			</div>
			<p className="text-xs text-muted-foreground">
				What this area's director sees on their page: counts, rates and dates
				for each club, and nothing that names a member.
			</p>
			{preview.status === "failed" ? (
				<p role="alert" className="text-sm text-destructive">
					{preview.message}
				</p>
			) : null}
			{preview.status === "ready" ? (
				<AreaHealthView health={preview.health} />
			) : null}
		</section>
	);
}
