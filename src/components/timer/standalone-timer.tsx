// src/components/timer/standalone-timer.tsx
//
// The public `/timer` page's body (#1248): a Toastmasters stopwatch with no
// club, meeting, identity or server write. Everything runs on this device.
//
// It renders the SAME `SegmentClock` the meeting timer does, with recording off
// (`canRecord: false`), and the band is `timerSignal(..., "speech")` — the rule
// whose `over` begins strictly after red + 0:30. Table Topics is a "speech" here
// too: the "tableTopics" kind reads a club's cap, and this page has no club.
import { useCallback, useEffect, useRef, useState } from "react";
import {
	SegmentClock,
	type TimerSegment,
	useWakeLock,
} from "#/components/timer/timer-clock";
import {
	disqualifiedAfter,
	fieldsForMarks,
	loadRemembered,
	type MarkFields,
	PRESETS,
	presetById,
	type Selection,
	saveRemembered,
	validateMarks,
} from "#/components/timer/timer-presets";
import {
	IDLE_TIMER,
	type TimerAction,
	type TimerState,
	timerReducer,
} from "#/lib/timer-state";

const DEFAULT_PRESET = presetById("speech");

const FIELD_LABELS: { key: keyof MarkFields; label: string }[] = [
	{ key: "green", label: "Green" },
	{ key: "yellow", label: "Yellow" },
	{ key: "red", label: "Red" },
];

export function StandaloneTimer() {
	// Defaults on the server and on first client render so hydration agrees;
	// whatever was remembered is applied after mount.
	const [selection, setSelection] = useState<Selection>(DEFAULT_PRESET.id);
	const [fields, setFields] = useState<MarkFields>(() =>
		fieldsForMarks(DEFAULT_PRESET.marks),
	);
	const [showClock, setShowClock] = useState(true);
	const [state, setState] = useState<TimerState>(IDLE_TIMER);
	const stateRef = useRef<TimerState>(IDLE_TIMER);
	const [now, setNow] = useState(() => Date.now());
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		const saved = loadRemembered();
		if (saved) {
			setSelection(saved.selection);
			setFields(saved.fields);
			setShowClock(saved.showClock);
		}
		setLoaded(true);
	}, []);

	useEffect(() => {
		if (loaded) saveRemembered({ selection, fields, showClock });
	}, [loaded, selection, fields, showClock]);

	const running = state.phase === "running";

	useEffect(() => {
		if (!running) return;
		const id = setInterval(() => setNow(Date.now()), 200);
		return () => clearInterval(id);
	}, [running]);

	useWakeLock(running);

	const dispatch = useCallback((action: TimerAction) => {
		stateRef.current = timerReducer(stateRef.current, action);
		setState(stateRef.current);
		setNow(Date.now());
	}, []);

	const result = validateMarks(fields);
	// Invalid marks keep the clock on the last valid set rather than inventing
	// one; Start is disabled so nothing can run against them.
	const lastValid = useRef(DEFAULT_PRESET.marks);
	if (result.ok) lastValid.current = result.marks;
	const marks = result.ok ? result.marks : lastValid.current;

	const segment: TimerSegment = {
		key: "standalone",
		slotId: null,
		roleLabel: "Timer",
		holder: null,
		marks,
		kind: "speech",
		recordable: false,
		unrecordableReason: null,
	};

	const pick = (next: Selection) => {
		setSelection(next);
		if (next !== "custom") setFields(fieldsForMarks(presetById(next).marks));
	};
	const edit = (key: keyof MarkFields, value: string) => {
		setSelection("custom");
		setFields((prev) => ({ ...prev, [key]: value }));
	};

	return (
		<main>
			<div className="mx-auto w-full max-w-reading space-y-4 p-4">
				<header className="space-y-1">
					<h1 className="font-display text-2xl font-semibold tracking-tight">
						Toastmasters timer
					</h1>
					<p className="text-muted-foreground text-sm">
						A green, yellow and red stopwatch for any speech. Nothing is saved
						or sent: it all runs on this device.
					</p>
				</header>

				<div className="flex flex-wrap gap-2">
					{[...PRESETS, { id: "custom" as const, label: "Custom" }].map((p) => (
						<button
							key={p.id}
							type="button"
							aria-pressed={selection === p.id}
							onClick={() => pick(p.id)}
							className={`min-h-11 rounded-full border px-4 text-sm font-medium ${
								selection === p.id
									? "border-primary bg-primary text-primary-foreground"
									: "border-[var(--line)]"
							}`}
						>
							{p.label}
						</button>
					))}
				</div>

				<div className="grid grid-cols-3 gap-3">
					{FIELD_LABELS.map(({ key, label }) => (
						<label key={key} className="space-y-1 text-sm font-medium">
							{label}
							<input
								value={fields[key]}
								onChange={(e) => edit(key, e.target.value)}
								disabled={running}
								inputMode="numeric"
								autoComplete="off"
								placeholder="m:ss"
								aria-invalid={!result.ok}
								className="block min-h-11 w-full rounded-md border border-[var(--line)] bg-background px-3 tabular-nums disabled:opacity-60"
							/>
						</label>
					))}
				</div>

				{result.ok ? (
					<p className="text-muted-foreground text-sm">
						Disqualified after {disqualifiedAfter(result.marks)}
					</p>
				) : (
					<p role="alert" className="text-destructive text-sm">
						{result.message}
					</p>
				)}

				<label className="flex min-h-11 items-center gap-2 text-sm font-medium">
					<input
						type="checkbox"
						checked={showClock}
						onChange={(e) => setShowClock(e.target.checked)}
						className="size-5"
					/>
					Show clock
				</label>
			</div>

			<SegmentClock
				variant="screen"
				segment={segment}
				state={state}
				now={now}
				limits={null}
				outcome={undefined}
				canRecord={false}
				showClock={showClock}
				startDisabled={!result.ok}
				onAction={dispatch}
			/>
		</main>
	);
}
