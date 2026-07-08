import { useCallback, useEffect, useState } from "react";
import type { Slide } from "#/lib/agenda-slides";

/** Full-screen, keyboard-driven slideshow. Read-only; position is local state. */
export function MeetingPresent({
	deck,
	onExit,
}: {
	deck: Slide[];
	onExit?: () => void;
}) {
	const [i, setI] = useState(0);
	const last = deck.length - 1;
	const next = useCallback(() => setI((n) => Math.min(n + 1, last)), [last]);
	const prev = useCallback(() => setI((n) => Math.max(n - 1, 0)), []);

	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
				e.preventDefault();
				next();
			} else if (e.key === "ArrowLeft" || e.key === "PageUp") {
				e.preventDefault();
				prev();
			} else if (e.key === "f" || e.key === "F") {
				if (document.fullscreenElement) document.exitFullscreen();
				else document.documentElement.requestFullscreen?.();
			} else if (e.key === "Escape") {
				if (document.fullscreenElement) {
					document.exitFullscreen();
				} else {
					onExit?.();
				}
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [next, prev, onExit]);

	const slide = deck[i];
	return (
		<div className="fixed inset-0 flex flex-col bg-[#4d121d] text-[#f6ecd8]">
			<button
				type="button"
				aria-label="Previous slide"
				className="absolute inset-y-0 left-0 w-1/4 cursor-w-resize opacity-0"
				onClick={prev}
			/>
			<button
				type="button"
				aria-label="Next slide"
				className="absolute inset-y-0 right-0 w-1/4 cursor-e-resize opacity-0"
				onClick={next}
			/>
			<div className="flex flex-1 items-center justify-center p-[6vmin]">
				<SlideView slide={slide} />
			</div>
			<div className="pointer-events-none absolute bottom-4 right-6 text-sm tabular-nums opacity-70">
				{`${i + 1} / ${deck.length}`}
			</div>
		</div>
	);
}

const EYEBROW =
	"mb-[3vmin] text-[2.2vmin] font-semibold uppercase tracking-[0.22em] text-[#e8cd8b]";
const HEAD = "text-balance text-[7vmin] font-bold leading-[1.02]";
const LEDE = "mt-[2vmin] text-[3vmin] opacity-90";

function SlideView({ slide }: { slide: Slide }) {
	switch (slide.kind) {
		case "title":
			return (
				<div className="text-center">
					<div className={EYEBROW}>
						{[
							slide.district,
							slide.clubNumber ? `Club #${slide.clubNumber}` : null,
						]
							.filter(Boolean)
							.join(" · ")}
					</div>
					<h1 className={HEAD}>{slide.clubName}</h1>
					<div className={LEDE}>
						{new Intl.DateTimeFormat(undefined, {
							weekday: "long",
							month: "long",
							day: "numeric",
							year: "numeric",
							timeZone: slide.timezone,
						}).format(slide.scheduledAt)}
						{" · "}
						{new Intl.DateTimeFormat(undefined, {
							hour: "numeric",
							minute: "2-digit",
							timeZone: slide.timezone,
						}).format(slide.scheduledAt)}
					</div>
				</div>
			);
		case "toastmaster":
			return (
				<div className="text-center">
					<div className={EYEBROW}>Toastmaster of the Day</div>
					<h1 className={HEAD}>{slide.name}</h1>
				</div>
			);
		case "theme":
			return (
				<div className="text-center">
					<div className={EYEBROW}>Meeting Theme</div>
					<h1 className={HEAD}>“{slide.theme}”</h1>
				</div>
			);
		case "wordOfDay":
			return (
				<div className="text-center">
					<div className={EYEBROW}>Word of the Day</div>
					<h1 className={HEAD}>{slide.word}</h1>
					{slide.definition ? (
						<div className={LEDE}>{slide.definition}</div>
					) : null}
					{slide.example ? (
						<div className="mt-[2vmin] text-[2.6vmin] italic text-[#e8cd8b]">
							“{slide.example}”
						</div>
					) : null}
				</div>
			);
		case "geIntro":
			return (
				<div className="text-center">
					<div className={EYEBROW}>General Evaluator</div>
					<h1 className={HEAD}>{slide.name}</h1>
					<div className={LEDE}>
						{slide.team.map((t) => `${t.role} · ${t.name}`).join("   ")}
					</div>
				</div>
			);
		case "speech":
			return (
				<div className="text-center">
					<div className={EYEBROW}>{slide.label}</div>
					<h1 className={HEAD}>{slide.speaker}</h1>
					{slide.title ? <div className={LEDE}>“{slide.title}”</div> : null}
					<div className="mt-[3vmin] text-[2.4vmin] text-[#e8cd8b]">
						{[slide.projectLevel, slide.time].filter(Boolean).join(" · ")}
					</div>
				</div>
			);
		case "voteSpeaker":
			return <VoteSlide title="Vote for Best Speaker" names={slide.names} />;
		case "tableTopics":
			return (
				<div className="text-center">
					<div className={EYEBROW}>Table Topics</div>
					<h1 className={HEAD}>{slide.master}</h1>
					<div className={LEDE}>Impromptu speaking · {slide.timing}</div>
				</div>
			);
		case "voteTableTopics":
			return <VoteSlide title="Vote for Best Table Topics" names={[]} />;
		case "evalIntro":
			return (
				<div className="text-center">
					<div className={EYEBROW}>Evaluation Session</div>
					<h1 className={HEAD}>{slide.name}</h1>
					<div className={LEDE}>{slide.time}</div>
				</div>
			);
		case "evaluation":
			return (
				<div className="text-center">
					<div className={EYEBROW}>{slide.label}</div>
					<h1 className={HEAD}>{slide.evaluator}</h1>
					<div className={LEDE}>
						{slide.speaker ? `Evaluates ${slide.speaker} · ` : ""}
						{slide.time}
					</div>
				</div>
			);
		case "voteEvaluator":
			return <VoteSlide title="Vote for Best Evaluator" names={slide.names} />;
		case "generalEvaluation":
			return (
				<div className="text-center">
					<div className={EYEBROW}>General Evaluation</div>
					<h1 className={HEAD}>{slide.name}</h1>
					<div className={LEDE}>Closing remarks · {slide.time}</div>
				</div>
			);
		case "awards":
			return (
				<div className="text-center">
					<div className={EYEBROW}>Awards</div>
					<div className="flex flex-col gap-[2vmin]">
						{slide.categories.map((c) => (
							<div key={c} className="text-[5vmin] font-bold">
								{c}
							</div>
						))}
					</div>
				</div>
			);
		case "reminders":
			return (
				<div className="max-w-[70vw] text-center">
					<div className={EYEBROW}>Reminders</div>
					<div className="whitespace-pre-line text-[3.4vmin] leading-snug">
						{slide.text}
					</div>
				</div>
			);
		case "thankYou":
			return (
				<div className="text-center">
					<h1 className={HEAD}>Thank you</h1>
					{slide.meetingSchedule ? (
						<div className={LEDE}>We meet {slide.meetingSchedule}</div>
					) : null}
				</div>
			);
	}
	return ((_exhaustive: never) => null)(slide);
}

function VoteSlide({ title, names }: { title: string; names: string[] }) {
	return (
		<div className="text-center">
			<div className={EYEBROW}>{title}</div>
			{names.length > 0 ? (
				<div className="flex flex-col gap-[1.5vmin]">
					{names.map((n) => (
						<div key={n} className="text-[4.5vmin] font-semibold">
							{n}
						</div>
					))}
				</div>
			) : (
				<h1 className={HEAD}>Cast your vote</h1>
			)}
		</div>
	);
}
