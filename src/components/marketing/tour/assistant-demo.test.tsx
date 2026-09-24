// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AI_CONNECTOR_SETUP_LINE,
	ASSISTANT_DEMO_MESSAGES,
	AssistantDemo,
	BUBBLE_GAP_MS,
} from "./assistant-demo";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function mockReducedMotion(reduce: boolean) {
	vi.stubGlobal(
		"matchMedia",
		vi.fn((query: string) => ({
			matches: reduce && query.includes("prefers-reduced-motion: reduce"),
			media: query,
			addEventListener: () => {},
			removeEventListener: () => {},
		})),
	);
}

/** A controllable IntersectionObserver: `fire()` reports the target visible. */
function mockIntersectionObserver() {
	const observers: Array<(e: Partial<IntersectionObserverEntry>[]) => void> =
		[];
	class FakeIO {
		constructor(cb: (e: Partial<IntersectionObserverEntry>[]) => void) {
			observers.push(cb);
		}
		observe() {}
		disconnect() {}
	}
	vi.stubGlobal("IntersectionObserver", FakeIO);
	return () =>
		act(() => {
			for (const cb of observers) cb([{ isIntersecting: true }]);
		});
}

const [userLine, assistantLine] = ASSISTANT_DEMO_MESSAGES.map((m) => m.text);

describe("AssistantDemo", () => {
	it("under prefers-reduced-motion: reduce, renders both bubbles on mount", () => {
		mockReducedMotion(true);
		// Even with an observer present, reduced motion does not wait on it.
		mockIntersectionObserver();
		render(<AssistantDemo />);
		expect(screen.getByText(userLine)).toBeTruthy();
		expect(screen.getByText(assistantLine)).toBeTruthy();
	});

	it("with motion but no IntersectionObserver, renders both bubbles on mount", () => {
		mockReducedMotion(false);
		// jsdom has none by default; stub it away explicitly so this cannot
		// pass because an earlier test left one behind.
		vi.stubGlobal("IntersectionObserver", undefined);
		render(<AssistantDemo />);
		expect(screen.getByText(userLine)).toBeTruthy();
		expect(screen.getByText(assistantLine)).toBeTruthy();
	});

	it("with motion, waits for view, then reveals the bubbles 700ms apart", () => {
		vi.useFakeTimers();
		mockReducedMotion(false);
		const fire = mockIntersectionObserver();
		render(<AssistantDemo />);
		expect(screen.queryByText(userLine)).toBeNull();

		fire();
		expect(screen.getByText(userLine)).toBeTruthy();
		expect(screen.queryByText(assistantLine)).toBeNull();

		act(() => vi.advanceTimersByTime(BUBBLE_GAP_MS - 1));
		expect(screen.queryByText(assistantLine)).toBeNull();
		act(() => vi.advanceTimersByTime(1));
		expect(screen.getByText(assistantLine)).toBeTruthy();
		expect(BUBBLE_GAP_MS).toBe(700);
	});

	it("shows the Beta badge and the connector setup line", () => {
		mockReducedMotion(true);
		render(<AssistantDemo />);
		expect(screen.getByText("Beta")).toBeTruthy();
		expect(screen.getByText(AI_CONNECTOR_SETUP_LINE)).toBeTruthy();
		// There is no per-club switch since #873 (`mayUseConnector` admits any
		// admin or officer of an open club), so the line must not promise one.
		expect(AI_CONNECTOR_SETUP_LINE).toMatch(/^For club officers\./);
		expect(AI_CONNECTOR_SETUP_LINE).not.toMatch(/switch it on|ask us/i);
	});
});
