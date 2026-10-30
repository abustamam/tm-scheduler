import { useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";

/** A navigation must be pending this long before the bar appears (#1424). */
export const PROGRESS_SHOW_DELAY_MS = 150;
const STEP_MS = 200;
const FADE_MS = 200;
const CEILING = 0.9;

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
 * it creeps toward 90% in 200ms steps, and on resolve jumps to 100% and fades
 * out over 200ms. With reduced motion it simply shows and hides.
 */
export function RouteProgress() {
	const pending = useRouterState({ select: (s) => s.status === "pending" });
	const [visible, setVisible] = useState(false);
	const [progress, setProgress] = useState(0);
	const [reduced, setReduced] = useState(false);

	useEffect(() => {
		setReduced(prefersReducedMotion());
	}, []);

	useEffect(() => {
		if (!pending) return;
		let step: ReturnType<typeof setInterval> | undefined;
		const show = setTimeout(() => {
			setProgress(0.1);
			setVisible(true);
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

	useEffect(() => {
		if (pending || !visible) return;
		// Resolved while shown: complete, then fade out and reset.
		setProgress(1);
		const hide = setTimeout(
			() => {
				setVisible(false);
				setProgress(0);
			},
			prefersReducedMotion() ? 0 : FADE_MS,
		);
		return () => clearTimeout(hide);
	}, [pending, visible]);

	const idle = !pending && !visible;
	return (
		<div
			role="progressbar"
			aria-label="Loading page"
			aria-hidden={idle ? true : undefined}
			data-testid="route-progress"
			data-state={visible ? (pending ? "loading" : "done") : "idle"}
			className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-[3px]"
			style={{
				// Fully opaque only while loading; on resolve it fades over FADE_MS.
				opacity: visible && pending ? 1 : 0,
				transition: reduced
					? "none"
					: `opacity ${FADE_MS}ms ease-out, transform ${STEP_MS}ms ease-out`,
			}}
		>
			<div
				className="h-full origin-left bg-primary"
				style={{
					transform: `scaleX(${reduced && visible ? 1 : progress})`,
					transition: reduced ? "none" : `transform ${STEP_MS}ms ease-out`,
				}}
			/>
		</div>
	);
}
