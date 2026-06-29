import type { MemberStatus } from "#/data/club";
import { statusMeta } from "#/data/club";
import { cn } from "#/lib/utils";

/**
 * Status pill: a soft `--foam` chip with a colored dot + label, used in the
 * roster table and member detail header.
 */
export function StatusPill({
	status,
	long = false,
	className,
}: {
	status: MemberStatus;
	/** Use the longer label (e.g. "Behind on goals") for the member-detail header. */
	long?: boolean;
	className?: string;
}) {
	const meta = statusMeta(status);
	const label = long ? meta.longLabel : meta.label;
	const dot = meta.dot;
	return (
		<span
			className={cn(
				"inline-flex w-fit items-center gap-[7px] rounded-full border border-[var(--line)] bg-[var(--foam)] px-2.5 py-[5px] text-[11.5px] font-semibold whitespace-nowrap",
				className,
			)}
		>
			<span
				className="size-[7px] shrink-0 rounded-full"
				style={{ background: dot }}
			/>
			{label}
		</span>
	);
}
