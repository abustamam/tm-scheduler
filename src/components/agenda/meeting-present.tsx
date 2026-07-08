import { useCallback, useEffect, useState } from "react";
import type { Slide } from "#/lib/agenda-slides";

// Plain, projection-friendly palette modeled on the official Toastmasters deck:
// light neutral ground, charcoal text, a small maroon accent rule, and a navy
// footer band. Deliberately single-theme (a projected deck is its own surface).
const INK = "#2b2b2b";
const MAROON = "#9b1c2e";
const NAVY = "#0a3a5a";
const GROUND = "#f3f4f4";

/** Full-screen, keyboard-driven slideshow. Read-only; position is local state. */
export function MeetingPresent({
	deck,
	clubName,
	onExit,
}: {
	deck: Slide[];
	clubName: string;
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
		<div
			className="fixed inset-0 flex flex-col"
			style={{ background: GROUND, color: INK }}
		>
			<button
				type="button"
				aria-label="Previous slide"
				className="absolute inset-y-0 left-0 z-10 w-1/4 cursor-w-resize opacity-0"
				onClick={prev}
			/>
			<button
				type="button"
				aria-label="Next slide"
				className="absolute inset-y-0 right-0 z-10 w-1/4 cursor-e-resize opacity-0"
				onClick={next}
			/>

			{/* Running club-name header (the title slide is its own splash). */}
			{slide.kind !== "title" ? (
				<header className="px-[6vmin] pt-[5vmin]">
					<h2 className="text-[3.2vmin] font-bold tracking-tight">
						{clubName}
					</h2>
					<div
						className="mt-[1.4vmin] h-[0.5vmin] w-[9vmin] rounded-full"
						style={{ background: MAROON }}
					/>
				</header>
			) : null}

			<div className="flex flex-1 items-center justify-center px-[8vmin] pb-[4vmin]">
				<SlideView slide={slide} />
			</div>

			<footer
				className="flex h-[7vmin] items-center justify-between px-[5vmin]"
				style={{ background: NAVY, color: GROUND }}
			>
				<span className="text-[2vmin] font-semibold uppercase tracking-[0.28em]">
					Toastmasters
				</span>
				<span className="text-[2vmin] tabular-nums opacity-90">
					{`${i + 1} / ${deck.length}`}
				</span>
			</footer>
		</div>
	);
}

const EYEBROW =
	"mb-[2.6vmin] text-[2.1vmin] font-semibold uppercase tracking-[0.22em]";
const HEAD = "text-balance text-[7vmin] font-bold leading-[1.05]";
const LEDE = "mt-[2vmin] text-[3vmin]";
const eyebrowStyle = { color: MAROON };
const ledeMuted = { color: "#565656" };

function SlideView({ slide }: { slide: Slide }) {
	switch (slide.kind) {
		case "title":
			return (
				<div className="text-center">
					<div className={EYEBROW} style={eyebrowStyle}>
						{[
							slide.district,
							slide.clubNumber ? `Club #${slide.clubNumber}` : null,
						]
							.filter(Boolean)
							.join(" · ")}
					</div>
					<h1 className={HEAD}>{slide.clubName}</h1>
					<div className={LEDE} style={ledeMuted}>
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
					<div className={EYEBROW} style={eyebrowStyle}>
						Toastmaster of the Day
					</div>
					<h1 className={HEAD}>{slide.name}</h1>
				</div>
			);
		case "theme":
			return (
				<div className="text-center">
					<div className={EYEBROW} style={eyebrowStyle}>
						Meeting Theme
					</div>
					<h1 className={HEAD}>“{slide.theme}”</h1>
				</div>
			);
		case "wordOfDay":
			return (
				<div className="text-center">
					<div className={EYEBROW} style={eyebrowStyle}>
						Word of the Day
					</div>
					<h1 className={HEAD}>{slide.word}</h1>
					{slide.definition ? (
						<div className={LEDE} style={ledeMuted}>
							{slide.definition}
						</div>
					) : null}
					{slide.example ? (
						<div className="mt-[2vmin] text-[2.6vmin] italic" style={ledeMuted}>
							“{slide.example}”
						</div>
					) : null}
				</div>
			);
		case "geIntro":
			return (
				<div className="text-center">
					<div className={EYEBROW} style={eyebrowStyle}>
						General Evaluator
					</div>
					<h1 className={HEAD}>{slide.name}</h1>
					<div className={LEDE} style={ledeMuted}>
						{slide.team.map((t) => `${t.role} · ${t.name}`).join("   ")}
					</div>
				</div>
			);
		case "speech":
			return (
				<div className="text-center">
					<div className={EYEBROW} style={eyebrowStyle}>
						{slide.label}
					</div>
					<h1 className={HEAD}>{slide.speaker}</h1>
					{slide.title ? (
						<div className={LEDE} style={ledeMuted}>
							“{slide.title}”
						</div>
					) : null}
					<div
						className="mt-[3vmin] text-[2.4vmin] font-semibold"
						style={eyebrowStyle}
					>
						{[slide.projectLevel, slide.time].filter(Boolean).join(" · ")}
					</div>
				</div>
			);
		case "voteSpeaker":
			return <VoteSlide title="Vote for Best Speaker" names={slide.names} />;
		case "tableTopics":
			return (
				<div className="text-center">
					<div className={EYEBROW} style={eyebrowStyle}>
						Table Topics
					</div>
					<h1 className={HEAD}>{slide.master}</h1>
					<div className={LEDE} style={ledeMuted}>
						Impromptu speaking · {slide.timing}
					</div>
				</div>
			);
		case "voteTableTopics":
			return <VoteSlide title="Vote for Best Table Topics" names={[]} />;
		case "evalIntro":
			return (
				<div className="text-center">
					<div className={EYEBROW} style={eyebrowStyle}>
						Evaluation Session
					</div>
					<h1 className={HEAD}>{slide.name}</h1>
					<div className={LEDE} style={ledeMuted}>
						{slide.time}
					</div>
				</div>
			);
		case "evaluation":
			return (
				<div className="text-center">
					<div className={EYEBROW} style={eyebrowStyle}>
						{slide.label}
					</div>
					<h1 className={HEAD}>{slide.evaluator}</h1>
					<div className={LEDE} style={ledeMuted}>
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
					<div className={EYEBROW} style={eyebrowStyle}>
						General Evaluation
					</div>
					<h1 className={HEAD}>{slide.name}</h1>
					<div className={LEDE} style={ledeMuted}>
						Closing remarks · {slide.time}
					</div>
				</div>
			);
		case "awards":
			return (
				<div className="text-center">
					<div className={EYEBROW} style={eyebrowStyle}>
						Awards
					</div>
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
				<div className="max-w-[74vw] text-center">
					<div className={EYEBROW} style={eyebrowStyle}>
						Reminders
					</div>
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
						<div className={LEDE} style={ledeMuted}>
							We meet {slide.meetingSchedule}
						</div>
					) : null}
				</div>
			);
	}
	return ((_exhaustive: never) => null)(slide);
}

function VoteSlide({ title, names }: { title: string; names: string[] }) {
	return (
		<div className="text-center">
			<div className={EYEBROW} style={eyebrowStyle}>
				{title}
			</div>
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
