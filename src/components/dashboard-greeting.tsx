import { useEffect, useState } from "react";

/**
 * The dashboard's H1 greeting (#608).
 *
 * Pure and router-free so it can be asserted directly — the route component
 * mounts a loader plus five server fns and cannot render standalone in jsdom
 * (the same reason `ClubHomeHeader` was extracted). That matters more here than
 * usual: the defect this component exists to close is visible ONLY by rendering
 * the server pass and the hydration pass separately, and a module that reaches
 * `#/db` cannot be rendered at all.
 */

export type GreetingPeriod = "morning" | "afternoon" | "evening";

/** Which greeting a 0-23 LOCAL hour earns. Noon and 18:00 are the edges. */
export function greetingPeriod(hour: number): GreetingPeriod {
	if (hour < 12) return "morning";
	if (hour < 18) return "afternoon";
	return "evening";
}

/**
 * The greeting line. `hour` is the VIEWER's local hour, or `null` for "nobody
 * has told us one yet" — which is what the server render and the first client
 * render both pass.
 *
 * The `null` arm is not a placeholder for a missing value; it is the only
 * answer a server is allowed to give. `getHours()` reads the process timezone,
 * and Railway runs the container in UTC, so a member in Los Angeles at 17:00
 * had the server render "Good morning, Nina" and the browser render "Good
 * evening, Nina" from one expression. React discards the server markup for that
 * subtree and re-renders it, which is a correctness warning on the most-visited
 * authed page — and, on a slow connection, a visibly wrong greeting that then
 * flips.
 *
 * Taking the hour as an ARGUMENT is what makes the two passes agree by
 * construction rather than by coincidence: this signature has no way to say
 * "read the clock", so an edit that wants the time of day has to go find an
 * hour, and the only place an hour exists is after mount. Deriving it from the
 * club's stored timezone was the other candidate and is rejected on the same
 * ground the issue names — it is wrong for a member who travels, and it leaves
 * the clock-during-render shape in place for the next person to copy.
 */
export function greetingText(displayName: string, hour: number | null): string {
	// Deliberately NOT `firstNameOf` from `#/lib/person-name`, though it is the
	// repo's shared "what to call this person" helper and the obvious cleanup
	// here. It reads the first comma as a `Last, First` separator, and the
	// likeliest comma on a Toastmasters DISPLAY name is a designation suffix —
	// so "Nina Patel, DTM" greets "DTM" and "John Smith, ACB, ALB" greets "ACB".
	// Both were measured, not reasoned about. `firstNameOf` is right for a
	// roster `people.name` (where the CSV really does emit "Khan, Zabihullah")
	// and wrong for this field; telling the two apart needs a signal neither
	// string carries, which is why this stays a plain first-token split.
	const who = displayName.trim().split(/\s+/)[0] || displayName;
	if (hour === null) return `Welcome back, ${who}`;
	return `Good ${greetingPeriod(hour)}, ${who}`;
}

export function DashboardGreeting({ name }: { name: string }) {
	// The house pre-mount guard (`NudgeButtons`, `WhatsAppPhoneLink`): the server
	// pass and EVERY first client render see `mounted === false`, so both emit the
	// neutral greeting and hydration has nothing to reconcile. The effect then
	// re-renders with the viewer's own clock.
	//
	// Read on each post-mount render rather than sampled once into state, so a
	// re-render — the loader re-runs on every Pathways mutation here — that
	// crosses 12:00 or 18:00 picks up the new period instead of holding the one
	// from mount.
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);
	const hour = mounted ? new Date().getHours() : null;

	return (
		<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
			{greetingText(name, hour)}
		</h1>
	);
}
