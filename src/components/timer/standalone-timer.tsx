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
	// Marks are fixed from Start until Reset: running, paused or stopped.
	const locked = state.phase !== "idle";
	const clockRef = useRef<HTMLDivElement>(null);
	const scrollOnStartRef = useRef(false);

	// Once Start has grown the block to full height, scroll it into view: asked
	// before that render, the browser clamps the target to the idle page's
	// short scroll range and the block lands low on the screen.
	useEffect(() => {
		if (state.phase === "idle" || !scrollOnStartRef.current) return;
		scrollOnStartRef.current = false;
		clockRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
	}, [state.phase]);

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
		// A phone held in landscape shows only a strip of page: bring the colour
		// block, which holds Start/Pause/Reset, to fill the screen once it runs.
		// Idle, the block is only as tall as its contents (#1270), so the scroll
		// waits for the render that grows it (see the effect below).
		if (action.type === "start") scrollOnStartRef.current = true;
	}, []);

	const result = validateMarks(fields);
	// Invalid marks show no clock at all (never a stale set): Start cannot be
	// reached, and the fields are only editable while idle.
	const segment: TimerSegment | null = result.ok
		? {
				key: "standalone",
				slotId: null,
				roleLabel: "Timer",
				holder: null,
				marks: result.marks,
				kind: "speech",
				recordable: false,
				unrecordableReason: null,
			}
		: null;

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
							disabled={locked}
							onClick={() => pick(p.id)}
							className={`min-h-11 rounded-full border px-4 text-sm font-medium disabled:opacity-60 ${
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
								disabled={locked}
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

			<div ref={clockRef}>
				{segment ? (
					<SegmentClock
						variant="screen"
						segment={segment}
						state={state}
						now={now}
						limits={null}
						outcome={undefined}
						canRecord={false}
						showClock={showClock}
						onAction={dispatch}
					/>
				) : (
					<p className="p-4 text-muted-foreground text-sm">
						Fix the marks above to start the clock.
					</p>
				)}
			</div>
		</main>
	);
}
