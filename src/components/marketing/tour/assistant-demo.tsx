import { useEffect, useRef, useState } from "react";

/**
 * Who may connect an assistant, and how, in one sentence (#867). One constant
 * so #852's change to the claude.ai setup lands in one place.
 */
export const AI_CONNECTOR_SETUP_LINE =
	"For club officers. Tested with Claude; ask us to switch it on for your club.";

export const ASSISTANT_DEMO_MESSAGES = [
	{ from: "user", text: "Put Dana in Speaker 2 on Thursday." },
	{
		from: "assistant",
		text: "Done. Dana Okafor is Speaker 2 for Thursday's meeting.",
	},
] as const;

/** Gap between the two bubbles when motion is allowed. */
export const BUBBLE_GAP_MS = 700;

function prefersReducedMotion(): boolean {
	return (
		typeof window !== "undefined" &&
		typeof window.matchMedia === "function" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

/**
 * Scene 5 of `/tour` (#867): a mock chat with the AI connector. Plays ONCE,
 * when it scrolls into view: the first bubble, then the second 700ms later.
 * Under reduced motion both show on mount, and so they do where there is no
 * `IntersectionObserver` to wait on.
 *
 * Nothing here talks to an assistant or to GavelUp; the two lines are fixed.
 */
export function AssistantDemo() {
	const ref = useRef<HTMLElement>(null);
	const [shown, setShown] = useState(0);

	useEffect(() => {
		const all = ASSISTANT_DEMO_MESSAGES.length;
		if (prefersReducedMotion() || typeof IntersectionObserver === "undefined") {
			setShown(all);
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const io = new IntersectionObserver((entries) => {
			if (!entries.some((e) => e.isIntersecting)) return;
			io.disconnect();
			setShown(1);
			timer = setTimeout(() => setShown(all), BUBBLE_GAP_MS);
		});
		if (ref.current) io.observe(ref.current);
		return () => {
			io.disconnect();
			if (timer) clearTimeout(timer);
		};
	}, []);

	return (
		<section
			ref={ref}
			aria-label="Example: asking an AI assistant to fill a role"
			className="flex flex-col gap-3 rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] p-4"
		>
			<div className="flex items-center justify-between">
				<span className="font-extrabold text-[11.5px] text-[var(--sea-ink-soft)] uppercase tracking-[0.08em]">
					Your assistant
				</span>
				<span className="rounded-full bg-warning-strong px-2.5 py-0.5 font-extrabold text-[11px] text-on-accent-fill uppercase tracking-[0.06em]">
					Beta
				</span>
			</div>
			{/* min-h reserves both bubbles' room, so revealing them moves nothing. */}
			<ol className="flex min-h-[8.5rem] flex-col gap-2.5">
				{ASSISTANT_DEMO_MESSAGES.slice(0, shown).map((m) => (
					<li
						key={m.from}
						className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[14.5px] leading-snug motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-200 motion-safe:ease-out ${
							m.from === "user"
								? "self-end rounded-br-md bg-primary text-primary-foreground"
								: "self-start rounded-bl-md bg-muted text-[var(--sea-ink)]"
						}`}
					>
						<span className="sr-only">
							{m.from === "user" ? "You: " : "Assistant: "}
						</span>
						{m.text}
					</li>
				))}
			</ol>
			<p className="text-sm text-[var(--sea-ink-soft)]">
				{AI_CONNECTOR_SETUP_LINE}
			</p>
		</section>
	);
}
