import { ExternalLink, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	isQuizComplete,
	PATH_QUIZ,
	type PathSuggestion,
	QUIZ_HANDOFF_HREF,
	type QuizAnswers,
	scorePathQuiz,
	stashQuizSuggestion,
	suggestionWhy,
	suggestPaths,
} from "#/lib/path-quiz";

/**
 * The path-selection quiz (#935), run entirely in the browser. Answers live in
 * component state and nowhere else: this module imports nothing from
 * `#/server`, and `path-quiz.test.tsx` asserts no request leaves the page
 * before "Use this path". It suggests; it never enrols. A signed-in member's
 * "Use this path" opens the dashboard picker with the path marked, and the
 * picker still lists every path.
 */
export function PathQuiz({ signedIn }: { signedIn: boolean }) {
	const [answers, setAnswers] = useState<QuizAnswers>({});
	const [showResult, setShowResult] = useState(false);
	const complete = isQuizComplete(answers);
	const resultRef = useRef<HTMLElement>(null);

	// The form is long and the result short: without this, a phone is left
	// scrolled past the end of the result it just asked for.
	useEffect(() => {
		if (showResult) resultRef.current?.scrollIntoView?.({ block: "start" });
	}, [showResult]);

	if (showResult) {
		const suggestions = suggestPaths(answers);
		// Every current path, in score order, so "browse all" is one scroll away
		// and never narrower than the picker itself.
		const all = scorePathQuiz(answers);
		return (
			<div className="flex flex-col gap-6">
				<section
					ref={resultRef}
					aria-labelledby="quiz-result-heading"
					className="scroll-mt-24"
				>
					<h2
						id="quiz-result-heading"
						className="mb-3 font-display text-xl font-semibold"
					>
						{suggestions.length > 1
							? "Two paths that fit your answers"
							: "A path that fits your answers"}
					</h2>
					<ul className="flex flex-col gap-3">
						{suggestions.map((s) => (
							<li key={s.courseCode}>
								<SuggestionCard suggestion={s} signedIn={signedIn} featured />
							</li>
						))}
					</ul>
					<p className="mt-3 text-sm text-[var(--sea-ink-soft)]">
						This is only a suggestion. Every path builds the same core speaking
						and leadership skills, and you can choose any of them.
					</p>
				</section>

				{signedIn ? null : (
					<div className="rounded-lg border border-[var(--line)] p-4">
						<p className="font-medium">
							Ask the club about it at your next visit.
						</p>
						<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
							Members are happy to tell you what their own path has been like.
						</p>
					</div>
				)}

				<section aria-labelledby="quiz-all-heading">
					<h2
						id="quiz-all-heading"
						className="mb-3 font-display text-lg font-semibold"
					>
						Or browse all paths
					</h2>
					<ul className="flex flex-col gap-2">
						{all.map((s) => (
							<li key={s.courseCode}>
								<SuggestionCard suggestion={s} signedIn={signedIn} />
							</li>
						))}
					</ul>
				</section>

				<Button
					type="button"
					variant="outline"
					className="self-start"
					onClick={() => {
						setAnswers({});
						setShowResult(false);
					}}
				>
					<RotateCcw className="size-4" aria-hidden />
					Start again
				</Button>
			</div>
		);
	}

	return (
		<form
			className="flex flex-col gap-6"
			onSubmit={(e) => {
				e.preventDefault();
				if (complete) setShowResult(true);
			}}
		>
			{PATH_QUIZ.map((q, i) => (
				<fieldset key={q.id} className="flex flex-col gap-2">
					<legend className="mb-2 font-medium">
						<span className="text-[var(--sea-ink-soft)]">{i + 1}. </span>
						{q.prompt}
					</legend>
					{q.options.map((o) => (
						<label
							key={o.id}
							className="flex cursor-pointer items-start gap-3 rounded-md border border-[var(--line)] px-3 py-2 text-sm has-[:checked]:border-[var(--lagoon-deep)] has-[:checked]:bg-[var(--sand)]"
						>
							<input
								type="radio"
								name={q.id}
								value={o.id}
								checked={answers[q.id] === o.id}
								onChange={() => setAnswers((a) => ({ ...a, [q.id]: o.id }))}
								className="mt-0.5"
							/>
							<span>{o.label}</span>
						</label>
					))}
				</fieldset>
			))}
			<div className="flex flex-col gap-1">
				<Button type="submit" className="self-start" disabled={!complete}>
					See my suggestion
				</Button>
				{complete ? null : (
					<p className="text-xs text-[var(--sea-ink-soft)]">
						Answer every question to see a suggestion.
					</p>
				)}
			</div>
		</form>
	);
}

function SuggestionCard({
	suggestion: s,
	signedIn,
	featured = false,
}: {
	suggestion: PathSuggestion;
	signedIn: boolean;
	featured?: boolean;
}) {
	const why = featured ? suggestionWhy(s) : "";
	return (
		<article
			aria-label={s.name}
			className={
				featured
					? "rounded-lg border border-[var(--lagoon-deep)] p-4"
					: "rounded-md border border-[var(--line)] px-3 py-2"
			}
		>
			<h3 className={featured ? "font-semibold text-lg" : "font-medium"}>
				{s.name}
			</h3>
			<p className="mt-1 text-sm">{s.focus}</p>
			{why ? (
				<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">{why}</p>
			) : null}
			<div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
				{signedIn ? (
					<Button asChild size="sm" variant={featured ? "default" : "outline"}>
						<a
							href={QUIZ_HANDOFF_HREF}
							onClick={() => stashQuizSuggestion(s.courseCode)}
						>
							Use this path
						</a>
					</Button>
				) : null}
				<a
					href={s.tiUrl}
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex items-center gap-1"
				>
					About this path on toastmasters.org
					<ExternalLink className="size-3.5" aria-hidden />
				</a>
			</div>
		</article>
	);
}
