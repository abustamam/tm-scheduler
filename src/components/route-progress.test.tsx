// @vitest-environment jsdom
//
// protects: the top progress bar (#1424) stays hidden for a navigation that
//   resolves inside 150ms, shows past 150ms, and hides within 250ms of idle.
// fails_when: the show delay is dropped (bar flashes on every click), the bar
//   never hides, or reduced motion still schedules the creep animation.
// no_claim: real router wiring (the status selector is stubbed here), and the
//   look of the bar; the root mount is covered by the QA pass.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROGRESS_SHOW_DELAY_MS, RouteProgress } from "./route-progress";

vi.mock("@tanstack/react-router", async () => {
	const React = await import("react");
	return {
		useRouterState: ({
			select,
		}: {
			select: (s: { status: string }) => unknown;
		}) => select({ status: React.useContext(StatusCtx) }),
	};
});

import { createContext, type ReactNode } from "react";

const StatusCtx = createContext<string>("idle");

function Harness({ s }: { s: "idle" | "pending" }): ReactNode {
	return (
		<StatusCtx.Provider value={s}>
			<RouteProgress />
		</StatusCtx.Provider>
	);
}

function setReduced(reduce: boolean) {
	window.matchMedia = ((q: string) => ({
		matches: reduce && q.includes("reduce"),
		media: q,
		addEventListener() {},
		removeEventListener() {},
	})) as unknown as typeof window.matchMedia;
}

const bar = () => screen.getByTestId("route-progress");

beforeEach(() => {
	vi.useFakeTimers();
	setReduced(false);
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("RouteProgress", () => {
	it("shows nothing when the loader resolves in under 150ms", () => {
		const { rerender } = render(<Harness s="pending" />);
		act(() => vi.advanceTimersByTime(PROGRESS_SHOW_DELAY_MS - 50));
		expect(bar().dataset.state).toBe("idle");
		rerender(<Harness s="idle" />);
		act(() => vi.advanceTimersByTime(1000));
		expect(bar().dataset.state).toBe("idle");
		expect(bar().getAttribute("aria-hidden")).toBe("true");
	});

	it("shows after 300ms pending and hides within 250ms of resolving", () => {
		const { rerender } = render(<Harness s="pending" />);
		act(() => vi.advanceTimersByTime(300));
		expect(bar().dataset.state).toBe("loading");
		expect(bar().getAttribute("role")).toBe("progressbar");
		expect(bar().getAttribute("aria-label")).toBe("Loading page");
		expect(bar().hasAttribute("aria-hidden")).toBe(false);
		rerender(<Harness s="idle" />);
		act(() => vi.advanceTimersByTime(250));
		expect(bar().dataset.state).toBe("idle");
		expect(bar().getAttribute("aria-hidden")).toBe("true");
	});

	it("creeps toward 0.9 but never past it while pending", () => {
		render(<Harness s="pending" />);
		act(() => vi.advanceTimersByTime(PROGRESS_SHOW_DELAY_MS + 5000));
		const inner = bar().firstElementChild as HTMLElement;
		const x = Number(/scaleX\(([\d.]+)\)/.exec(inner.style.transform)?.[1]);
		expect(x).toBeGreaterThan(0.5);
		expect(x).toBeLessThanOrEqual(0.9);
	});

	it("with reduced motion: shows full width, no transition, hides at once", () => {
		setReduced(true);
		const { rerender } = render(<Harness s="pending" />);
		act(() => vi.advanceTimersByTime(PROGRESS_SHOW_DELAY_MS + 1));
		const inner = bar().firstElementChild as HTMLElement;
		expect(inner.style.transform).toBe("scaleX(1)");
		expect(inner.style.transition).toBe("none");
		act(() => vi.advanceTimersByTime(2000));
		expect(inner.style.transform).toBe("scaleX(1)");
		rerender(<Harness s="idle" />);
		act(() => vi.advanceTimersByTime(1));
		expect(bar().dataset.state).toBe("idle");
	});
});
