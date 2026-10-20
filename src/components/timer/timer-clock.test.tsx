// @vitest-environment jsdom
//
// #1270: the `screen` variant's full-viewport height belongs to a started clock
// only. Idle, it is as tall as its contents so Start sits on a phone's first
// screen. The `card` variant is the meeting page's and does not change.
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { IDLE_TIMER, type TimerState } from "#/lib/timer-state";
import { SegmentClock, type TimerSegment } from "./timer-clock";

const SEGMENT: TimerSegment = {
	key: "s",
	slotId: null,
	roleLabel: "Speech",
	holder: null,
	marks: { green: 5, yellow: 6, red: 7 },
	kind: "speech",
	recordable: false,
	unrecordableReason: null,
} as TimerSegment;

const STATES: Record<string, TimerState> = {
	idle: IDLE_TIMER,
	running: { phase: "running", accumulatedMs: 0, startedAt: 1000 },
	paused: { phase: "paused", accumulatedMs: 2000, startedAt: null },
};

function container(variant: "card" | "screen", state: TimerState) {
	const { container } = render(
		<SegmentClock
			segment={SEGMENT}
			state={state}
			now={3000}
			limits={null}
			outcome={undefined}
			canRecord={false}
			onAction={() => {}}
			variant={variant}
		/>,
	);
	return (container.querySelector("[data-band]") as HTMLElement).className;
}

afterEach(cleanup);

describe("screen variant height by phase", () => {
	it("idle has no full-viewport min-height", () => {
		expect(container("screen", STATES.idle)).not.toContain("min-h-svh");
	});
	it.each(["running", "paused"])("%s fills the viewport", (phase) => {
		expect(container("screen", STATES[phase])).toContain("min-h-svh");
	});
});

describe("card variant", () => {
	it.each(Object.keys(STATES))("%s markup is unchanged", (phase) => {
		expect(container("card", STATES[phase])).toBe(
			"space-y-3 rounded-lg border border-[var(--line)] p-3",
		);
	});
});
