import { useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";

/** A navigation must be pending this long before the bar appears (#1424). */
export const PROGRESS_SHOW_DELAY_MS = 150;
/** The creep step while pending, and the grow transition's length. */
const STEP_MS = 200;
/** Time the bar spends reaching 100% before the fade starts. */
export const COMPLETE_MS = 50;
/** The fade-out. COMPLETE_MS + FADE_MS = 250ms: the "gone within 250ms" bar. */
export const FADE_MS = 200;
const CEILING = 0.9;

// DESIGN.md Motion: enter ease-out, exit ease-in.
const EASE_OUT = "cubic-bezier(0.2, 0, 0, 1)";
const EASE_IN = "cubic-bezier(0.4, 0, 1, 1)";

type Phase = "idle" | "loading" | "completing" | "fading";

function prefersReducedMotion(): boolean {
	try {
		return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	} catch {
		return false;
	}
}

/**
 * A 3px bar at the top of the viewport while a client navigation's loader is
 * pending. Hidden for the first 150ms so a fast navigation shows nothing; then
 * it creeps toward 90% in 200ms steps. On resolve it grows to 100% (50ms),
 * then fades out over 200ms. A navigation that starts mid-fade resets the bar
 * to idle at once, so it never shows a full bar that jumps back. With reduced
 * motion it simply shows and hides.
 */
export function RouteProgress() {
	const pending = useRouterState({ select: (s) => s.status === "pending" });
	const [phase, setPhase] = useState<Phase>("idle");
	const [progress, setProgress] = useState(0);
	const [reduced, setReduced] = useState(false);

	useEffect(() => {
		setReduced(prefersReducedMotion());
	}, []);

	// A new navigation: drop any finishing bar, then show after the delay.
	useEffect(() => {
		if (!pending) return;
		setPhase("idle");
		setProgress(0);
		let step: ReturnType<typeof setInterval> | undefined;
		const show = setTimeout(() => {
			setProgress(0.1);
			setPhase("loading");
			if (!prefersReducedMotion()) {
				step = setInterval(
					() => setProgress((p) => p + (CEILING - p) * 0.3),
					STEP_MS,
				);
			}
		}, PROGRESS_SHOW_DELAY_MS);
		return () => {
			clearTimeout(show);
			if (step) clearInterval(step);
		};
	}, [pending]);

	// Resolved while shown: complete, then fade, then reset.
	useEffect(() => {
		if (pending) return;
		if (phase === "loading") {
			if (prefersReducedMotion()) {
				setPhase("idle");
				setProgress(0);
				return;
			}
			setProgress(1);
			setPhase("completing");
			return;
		}
		if (phase === "completing") {
			const t = setTimeout(() => setPhase("fading"), COMPLETE_MS);
			return () => clearTimeout(t);
		}
		if (phase === "fading") {
			const t = setTimeout(() => {
				setPhase("idle");
				setProgress(0);
			}, FADE_MS);
			return () => clearTimeout(t);
		}
	}, [pending, phase]);

	const shown = phase === "loading" || phase === "completing";
	return (
		<div
			role="progressbar"
			aria-label="Loading page"
			aria-hidden={phase === "idle" ? true : undefined}
			data-testid="route-progress"
			data-state={phase}
			className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-[3px]"
			style={{
				opacity: shown ? 1 : 0,
				// Only the fade animates the outer element.
				transition:
					phase === "fading" && !reduced
						? `opacity ${FADE_MS}ms ${EASE_IN}`
						: "none",
			}}
		>
			<div
				className="h-full origin-left bg-primary"
				style={{
					transform: `scaleX(${reduced && shown ? 1 : progress})`,
					// Only the grow animates the inner element; not on reset to 0.
					transition:
						reduced || phase === "idle" || phase === "fading"
							? "none"
							: `transform ${phase === "completing" ? COMPLETE_MS : STEP_MS}ms ${EASE_OUT}`,
				}}
			/>
		</div>
	);
}
