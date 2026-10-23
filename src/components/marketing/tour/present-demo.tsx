import { QRCodeSVG } from "qrcode.react";
import type { ReactNode } from "react";
import { useState } from "react";

/**
 * Scene 3 of `/tour`: a small working deck, a facsimile of present mode
 * (`meeting-present.tsx`) with five of its real slides. It replaces a
 * screenshot so a visitor can click through it.
 *
 * The colours are the SLIDE'S own, in both themes, like a projector: a deck
 * does not follow the app's light/dark switch, so raw hex is correct here and
 * theme tokens would be wrong. The values are copied from
 * `meeting-present.tsx` (which does not export them).
 *
 * Local state only. The QR codes are real codes (`qrcode.react`, the encoder
 * present mode itself uses) of the public `/tour` URL: deterministic, so SSR
 * and hydration agree, and harmless if someone scans the screen.
 *
 * Keyboard: the deck is focusable; Right/PageDown/Space go forward and
 * Left/PageUp back, clamped at both ends. The two invisible side zones are real
 * buttons, so a pointer or a screen reader has the same two moves.
 */
const INK = "#2b2b2b";
const MAROON = "#770D29";
const NAVY = "#004062";
const GROUND = "#f3f4f4";
const GOLD = "#f3dd94";
const NAVY_GRADIENT = "linear-gradient(160deg, #0a4f78, #002a41)";

const CLUB = "Harbor City Speakers";
const FOOTER_DATE = "Oct 30";
const QR_URL = "https://gavelup.app/tour";

type Slide = { title: string; body: ReactNode; dark?: boolean };

function Qr({ caption }: { caption: string }) {
	return (
		<div className="shrink-0 text-center">
			<div
				aria-hidden
				className="mx-auto rounded-md bg-white p-[1.2cqw]"
				style={{ width: "17cqw", height: "17cqw" }}
			>
				<QRCodeSVG
					value={QR_URL}
					marginSize={0}
					style={{ width: "100%", height: "100%" }}
				/>
			</div>
			<p className="mt-[1cqw] font-semibold text-[2.2cqw]">{caption}</p>
		</div>
	);
}

const BULLET = "flex gap-[1cqw]";

const SLIDES: readonly Slide[] = [
	{
		title: "Title slide",
		dark: true,
		body: (
			<div className="px-[6cqw] text-center">
				<div
					className="font-display font-semibold text-[6cqw] leading-tight"
					style={{ color: GOLD }}
				>
					{CLUB}
				</div>
				<p className="mt-[2cqw] text-[2.2cqw] leading-snug text-white/85">
					District 57 · Club #1234567 · Meeting #412
					<br />
					Thursday, October 30 · Start time 7:00 PM
				</p>
			</div>
		),
	},
	{
		title: "Speech",
		body: (
			<ul className="flex flex-col gap-[1.2cqw] text-[3cqw] leading-snug">
				<li className={BULLET}>
					<span aria-hidden>•</span>
					<span>
						<b>Speaker:</b> Priya Nair
					</span>
				</li>
				<li className={BULLET}>
					<span aria-hidden>•</span>
					<span>
						<b>Speech Title:</b> “What the Tide Leaves”
					</span>
				</li>
				<li className={BULLET}>
					<span aria-hidden>•</span>
					<span>
						<b>Project:</b> Presentation Mastery · Level 2
					</span>
				</li>
				<li className={BULLET}>
					<span aria-hidden>•</span>
					<span>
						<b>Time:</b> 5–7 min
					</span>
				</li>
			</ul>
		),
	},
	{
		title: "Vote for Best Speaker",
		body: (
			<div className="flex items-center gap-[4cqw]">
				<ul className="flex-1 text-[3.2cqw] font-semibold leading-snug">
					<li>Priya Nair</li>
					<li>Daniel Osei</li>
					<li>Mei Tanaka</li>
				</ul>
				<div>
					<Qr caption="Scan to vote" />
					<p className="text-center text-[1.7cqw] opacity-70">14 votes in</p>
				</div>
			</div>
		),
	},
	{
		title: "What's on tap for next meeting",
		body: (
			<div className="flex items-center gap-[4cqw]">
				<ul className="flex-1 text-[2.6cqw] leading-snug">
					<li>
						<b>Toastmaster</b> · Marcus Lee
					</li>
					<li>
						<b>Speaker 1</b> · <i>Open</i>
					</li>
					<li>
						<b>Speaker 2</b> · Ana Ruiz
					</li>
					<li>
						<b>Evaluator 1</b> · <i>Open</i>
					</li>
					<li>
						<b>Timer</b> · <i>Open</i>
					</li>
				</ul>
				<Qr caption="Scan to grab a role" />
			</div>
		),
	},
	{
		title: "Thank You",
		dark: true,
		body: (
			<div className="text-center">
				<div
					className="font-display font-semibold text-[8cqw] leading-none"
					style={{ color: GOLD }}
				>
					Thank You
				</div>
				<p className="mt-[3cqw] text-[2.6cqw] text-white/85">
					See you next Thursday.
				</p>
			</div>
		),
	},
];

const ZONE =
	"absolute top-0 bottom-0 z-10 w-1/4 cursor-pointer bg-transparent hover:bg-white/5 focus-visible:outline-none";

function SlideFrame({ slide }: { slide: Slide }) {
	if (slide.dark) {
		return (
			<div
				className="flex h-full w-full items-center justify-center"
				style={{ background: NAVY_GRADIENT }}
			>
				{slide.body}
			</div>
		);
	}
	return (
		<div
			className="flex h-full w-full flex-col"
			style={{ background: GROUND, color: INK }}
		>
			<header className="px-[5cqw] pt-[3.4cqw]">
				<div className="font-extrabold text-[3.9cqw] leading-tight">
					{slide.title}
				</div>
				<div
					className="mt-[1.5cqw] h-[0.7cqw] w-[8cqw] rounded"
					style={{ background: MAROON }}
				/>
			</header>
			<div className="flex min-h-0 flex-1 flex-col justify-center px-[5cqw]">
				{slide.body}
			</div>
			<footer
				className="flex items-center justify-between px-[5cqw] py-[1.8cqw]"
				style={{ background: NAVY }}
			>
				<div className="font-display font-semibold text-[2.8cqw] text-white">
					GavelUp
				</div>
				<div className="text-right leading-tight text-white">
					<div className="font-bold text-[2.4cqw]">{CLUB}</div>
					<div className="text-[2cqw] opacity-90">{FOOTER_DATE}</div>
				</div>
			</footer>
		</div>
	);
}

export function PresentDemo() {
	const [index, setIndex] = useState(0);
	const last = SLIDES.length - 1;
	const slide = SLIDES[index];

	function go(delta: number) {
		setIndex((i) => Math.max(0, Math.min(last, i + delta)));
	}

	function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
		if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
			e.preventDefault();
			go(1);
		} else if (e.key === "ArrowLeft" || e.key === "PageUp") {
			e.preventDefault();
			go(-1);
		}
	}

	return (
		<section
			aria-label="Try it: click through the projector deck"
			className="flex flex-col gap-3"
		>
			{/* biome-ignore lint/a11y/useSemanticElements: a focusable region that owns the arrow keys, like the real deck; the two zones inside are the real buttons. */}
			<div
				role="group"
				aria-label="Sample slide deck. Use the arrow keys or click the left and right edges."
				// biome-ignore lint/a11y/noNoninteractiveTabindex: the keyboard target for the deck's arrow keys.
				tabIndex={0}
				onKeyDown={onKeyDown}
				className="@container relative aspect-video w-full select-none overflow-hidden rounded-xl shadow-[0_20px_50px_rgba(23,58,64,.18)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
			>
				<SlideFrame slide={slide} />
				<div
					aria-hidden
					className="absolute top-[0.8cqw] left-1/2 z-20 -translate-x-1/2 rounded-full bg-black/35 px-[1.4cqw] py-[0.3cqw] text-[1.6cqw] text-white/90 tabular-nums"
				>
					{index + 1} / {SLIDES.length}
				</div>
				<button
					type="button"
					aria-label="Previous slide"
					onClick={() => go(-1)}
					className={`${ZONE} left-0`}
				/>
				<button
					type="button"
					aria-label="Next slide"
					onClick={() => go(1)}
					className={`${ZONE} right-0`}
				/>
			</div>
			<p className="text-sm text-[var(--sea-ink-soft)]">
				Click the right side for the next slide, the left side to go back. Arrow
				keys work too.
			</p>
			<output aria-live="polite" className="sr-only">
				{`Slide ${index + 1} of ${SLIDES.length}: ${slide.title}`}
			</output>
		</section>
	);
}
