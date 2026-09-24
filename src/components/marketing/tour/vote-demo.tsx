import { useState } from "react";

/**
 * Scene 4 of `/tour` (#867), right half: a best-speaker ballot. One tap casts
 * one vote, the tally moves, and the ballot locks until "Vote again".
 *
 * Fictional speakers from the seed club (`src/db/seed.ts`, Harbor City
 * Speakers). The starting tallies are there so a single vote has something to
 * land on; "Vote again" puts them back, because it stands for the next person
 * holding the phone rather than a second vote by the first.
 */
export const VOTE_DEMO_SPEAKERS = [
	{ name: "Priya Nair", start: 3 },
	{ name: "Marcus Lee", start: 2 },
	{ name: "Nina Petrov", start: 4 },
] as const;

const initialTallies = () => VOTE_DEMO_SPEAKERS.map((s) => s.start);

export function VoteDemo() {
	const [tallies, setTallies] = useState<number[]>(initialTallies);
	const [votedFor, setVotedFor] = useState<number | null>(null);

	return (
		<section
			aria-label="Try it: vote for best speaker"
			className="flex flex-col gap-3 rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] p-4"
		>
			<div className="font-extrabold text-[11.5px] text-[var(--sea-ink-soft)] uppercase tracking-[0.08em]">
				Best speaker
			</div>
			<ul className="flex flex-col gap-2">
				{VOTE_DEMO_SPEAKERS.map((s, idx) => (
					<li key={s.name}>
						<button
							type="button"
							disabled={votedFor !== null}
							aria-label={`Vote for ${s.name}`}
							onClick={() => {
								setTallies((t) => t.map((n, j) => (j === idx ? n + 1 : n)));
								setVotedFor(idx);
							}}
							className={`flex w-full items-center justify-between rounded-xl border px-3 py-2.5 text-left font-bold text-[14px] motion-safe:transition-colors motion-safe:duration-200 motion-safe:ease-out enabled:cursor-pointer enabled:hover:border-[var(--lagoon-deep)] disabled:cursor-default ${
								votedFor === idx
									? "border-[var(--palm)] bg-success text-success-foreground"
									: "border-[var(--line)]"
							}`}
						>
							<span>{s.name}</span>
							<span data-testid={`tally-${idx}`} className="tabular-nums">
								{tallies[idx]}
							</span>
						</button>
					</li>
				))}
			</ul>
			<div className="flex h-6 items-center justify-between text-sm">
				<span aria-live="polite" className="text-[var(--sea-ink-soft)]">
					{votedFor === null ? "Tap a name." : "Vote counted."}
				</span>
				{votedFor !== null ? (
					<button
						type="button"
						onClick={() => {
							setTallies(initialTallies());
							setVotedFor(null);
						}}
						className="cursor-pointer font-semibold text-[var(--lagoon-deep)] underline-offset-2 hover:underline"
					>
						Vote again
					</button>
				) : null}
			</div>
		</section>
	);
}
