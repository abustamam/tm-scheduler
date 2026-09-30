import {
	ATTENDANCE_MODE_LABELS,
	ATTENDANCE_MODES,
	type AttendanceMode,
} from "#/lib/attendance-mode";
import { cn } from "#/lib/utils";

/**
 * In person / online, for one person recorded present (#1049). A two-segment
 * control, not a checkbox, because NULL is a real third state: a row recorded
 * before #1049 (or never toggled) has NEITHER segment pressed, and pressing one
 * is the officer choosing it. Nothing here picks a value on their behalf.
 *
 * Each segment's accessible name is composed from CONTENT — one `sr-only` span
 * carrying the whole string, the visible word `aria-hidden` — for the reason the
 * attendance panel's status triggers give: `aria-label` overrides content, and a
 * name split across siblings gains its separator in a browser and not in jsdom.
 * "In person" alone, forty times down a roster, says nothing about whom.
 */
export function AttendanceModeToggle({
	name,
	mode,
	disabled,
	onChange,
	className,
}: {
	/** Whose mode this is — goes into each segment's accessible name. */
	name: string;
	/** The RECORDED mode; `null` = not recorded, so neither segment is pressed. */
	mode: AttendanceMode | null;
	disabled: boolean;
	onChange: (mode: AttendanceMode) => void;
	className?: string;
}) {
	return (
		<fieldset
			className={cn(
				"inline-flex shrink-0 overflow-hidden rounded-md border border-input",
				className,
			)}
		>
			<legend className="sr-only">How {name} attended</legend>
			{ATTENDANCE_MODES.map((m) => {
				const pressed = mode === m;
				return (
					<button
						key={m}
						type="button"
						aria-pressed={pressed}
						disabled={disabled}
						onClick={() => {
							// Re-pressing the recorded value writes nothing: it is already
							// the record, and a write would cost a round trip and a
							// router invalidate for no change.
							if (disabled || pressed) return;
							onChange(m);
						}}
						// `min-h-6`: WCAG 2.5.8's 24px target, the floor every other
						// control on this rail is sized to. `disabled:` styling because a
						// bare `<button>` gets none from `buttonVariants`.
						className={cn(
							"inline-flex min-h-6 items-center px-2 text-xs disabled:pointer-events-none disabled:opacity-50",
							pressed
								? "bg-secondary font-medium text-secondary-foreground"
								: "text-muted-foreground hover:bg-muted",
						)}
					>
						<span className="sr-only">
							{name} attended {ATTENDANCE_MODE_LABELS[m].toLowerCase()}
						</span>
						<span aria-hidden>{ATTENDANCE_MODE_LABELS[m]}</span>
					</button>
				);
			})}
		</fieldset>
	);
}
