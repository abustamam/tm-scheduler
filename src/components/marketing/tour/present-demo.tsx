import { QRCodeSVG } from "qrcode.react";
import type { ReactNode } from "react";
import { useState } from "react";
import {
	GOLD,
	GROUND,
	INK,
	MAROON,
	MUTED,
	NAVY,
	NAVY_GRADIENT_BOTTOM,
	NAVY_GRADIENT_TOP,
} from "#/lib/slide-palette";

/**
 * Scene 3 of `/tour`: a small working deck, a facsimile of present mode
 * (`meeting-present.tsx`) with five of its real slides. It replaces a
 * screenshot so a visitor can click through it.
 *
 * The colours are the SLIDE'S own, in both themes, like a projector: a deck
 * does not follow the app's light/dark switch, so raw hex is correct here and
 * theme tokens would be wrong. They come from `#/lib/slide-palette`, the same
 * module the real deck reads.
 *
 * Local state only. The QR codes are real codes (`qrcode.react`, the encoder
 * present mode itself uses) of the public `/tour` URL: deterministic, so SSR
 * and hydration agree, and harmless if someone scans the screen.
 *
 * Keyboard: the deck is focusable; Right/PageDown/Space go forward and
 * Left/PageUp back, clamped at both ends. The two invisible side zones are real
 * buttons, so a pointer or a screen reader has the same two moves.
 */
const CLUB = "Harbor City Speakers";
const FOOTER_DATE = "October 29, 2026";
const QR_URL = "https://gavelup.app/tour";

type Slide = {
	title: string;
	body: ReactNode;
	/** "splash" fills the frame with no header or footer, as `Splash` does. */
	chrome: "content" | "splash-light" | "splash-dark";
};

function Qr({ caption, edge }: { caption: string; edge: string }) {
	return (
		<div className="flex shrink-0 flex-col items-center gap-[1cqw]">
			<div
				aria-hidden
				className="rounded-[1.2cqw] bg-white p-[1.2cqw]"
				style={{ width: edge, height: edge }}
			>
				<QRCodeSVG
					value={QR_URL}
					marginSize={0}
					style={{ display: "block", width: "100%", height: "100%" }}
				/>
			</div>
			<p className="font-semibold text-[2.2cqw]">{caption}</p>
		</div>
	);
}

/** `MUTED` sub-lines of a light splash, as `LineView`'s "muted" role. */
function Muted({ children }: { children: ReactNode }) {
	return (
		<div className="text-[2.5cqw] leading-snug" style={{ color: MUTED }}>
			{children}
		</div>
	);
}

const BULLET = "flex gap-[1cqw]";
const MAROON_BOLD = { fontWeight: 800, color: MAROON } as const;

const SLIDES: readonly Slide[] = [
	{
		title: "Title slide",
		chrome: "splash-light",
		body: (
			<>
				<div
					className="font-display font-semibold text-[6cqw] tracking-[-0.01em]"
					style={{ color: NAVY }}
				>
					Toastmasters
				</div>
				<div
					className="my-[3.4cqw] h-px"
					style={{ width: "58cqw", background: NAVY }}
				/>
				<div
					className="font-bold text-[6.4cqw] leading-tight"
					style={{ color: INK }}
				>
					{CLUB}
				</div>
				<div className="mt-[2.6cqw] flex flex-col gap-[0.7cqw]">
					<Muted>District 57</Muted>
					<Muted>Club #1234567</Muted>
					<Muted>Meeting #412</Muted>
					<Muted>Thursday, October 29, 2026</Muted>
					<Muted>Start time: 7:00 PM</Muted>
				</div>
			</>
		),
	},
	{
		title: "Speech",
		chrome: "content",
		body: (
			<ul className="flex flex-col gap-[1.2cqw] text-[3cqw] leading-snug">
				<li className={BULLET}>
					<span aria-hidden>•</span>
					<span>Speaker: Priya Nair</span>
				</li>
				<li className={BULLET}>
					<span aria-hidden>•</span>
					<span>Speech Title: “What the Tide Leaves”</span>
				</li>
				<li className={BULLET}>
					<span aria-hidden>•</span>
					<span>Project: Presentation Mastery · Level 2</span>
				</li>
				<li className={BULLET}>
					<span aria-hidden>•</span>
					<span>Time: 5–7 minutes</span>
				</li>
			</ul>
		),
	},
	{
		title: "Vote for Best Speaker",
		chrome: "content",
		body: (
			<div className="flex items-center gap-[4cqw]">
				<ul className="flex-1 text-[3.2cqw] font-semibold leading-snug">
					<li>Priya Nair</li>
					<li>Daniel Osei</li>
					<li>Mei Tanaka</li>
				</ul>
				<div className="flex flex-col items-center">
					<Qr caption="Scan to vote" edge="17cqw" />
					<p className="text-[1.7cqw] opacity-70">14 votes in</p>
				</div>
			</div>
		),
	},
	{
		title: "What's on tap for next meeting",
		chrome: "content",
		body: (
			<div className="flex flex-col gap-[1cqw]">
				<div className="flex items-center gap-[3cqw]">
					<div className="flex min-w-0 flex-1 flex-col gap-[0.7cqw]">
						<div className="font-semibold text-[2cqw] leading-tight">
							Thursday, November 5, 2026 · 7:00 PM · Harbor City Library
						</div>
						<div className="font-bold text-[2.8cqw] leading-tight">
							<span style={{ fontWeight: 800 }}>Toastmaster:</span> Marcus Lee
						</div>
						<div
							className="text-[1.8cqw] leading-tight"
							style={{ color: MUTED }}
						>
							Meeting #413
						</div>
					</div>
					<Qr caption="Scan to grab a role" edge="11cqw" />
				</div>
				<div className="grid grid-cols-2 gap-x-[2.5cqw] gap-y-[0.5cqw] text-[1.8cqw] leading-tight">
					<div>
						<b>Speaker 1:</b>
						<span style={MAROON_BOLD}> Open: grab it!</span>
					</div>
					<div>
						<b>Evaluator 1:</b>
						<span style={MAROON_BOLD}> Open: grab it!</span>
					</div>
					<div>
						<b>Speaker 2:</b> Ana Ruiz
					</div>
					<div>
						<b>Timer:</b>
						<span style={MAROON_BOLD}> Open: grab it!</span>
					</div>
				</div>
			</div>
		),
	},
	{
		title: "Thank You",
		chrome: "splash-dark",
		body: (
			<>
				<div
					className="my-[3.4cqw] h-px"
					style={{ width: "58cqw", background: "rgba(255,255,255,.55)" }}
				/>
				<div
					className="font-bold text-[6.4cqw] leading-tight"
					style={{ color: GOLD }}
				>
					Thank You
				</div>
				<div className="mt-[2.6cqw] flex flex-col gap-[0.7cqw]">
					<div className="text-[2.5cqw] leading-snug">
						CONGRATULATIONS on another great learning session!
					</div>
					<div className="h-[2.4cqw]" />
					<div className="text-[2.5cqw] leading-snug">Next Meeting:</div>
					<div className="font-semibold text-[2.8cqw] leading-tight">
						Thursday, November 5, 2026
					</div>
					<div className="font-semibold text-[2.8cqw] leading-tight">
						7:00 PM
					</div>
				</div>
			</>
		),
	},
];

const ZONE =
	"absolute top-0 bottom-0 z-10 w-1/4 cursor-pointer bg-transparent hover:bg-white/5 focus-visible:outline-none";

function SlideFrame({ slide }: { slide: Slide }) {
	if (slide.chrome !== "content") {
		const dark = slide.chrome === "splash-dark";
		return (
			<div
				className="flex h-full w-full flex-col items-center justify-center px-[8cqw] text-center"
				style={
					dark
						? {
								background: `linear-gradient(180deg, ${NAVY_GRADIENT_TOP} 0%, ${NAVY_GRADIENT_BOTTOM} 100%)`,
								color: "#eaf1f6",
							}
						: { background: GROUND, color: INK }
				}
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
				<div className="font-bold text-[3.9cqw] leading-tight">
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
					className="absolute top-[0.8cqw] left-1/2 z-20 -translate-x-1/2 rounded-full bg-black/35 px-[1.4cqw] py-[0.3cqw] text-[1.6cqw] text-white tabular-nums"
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
			<p className="text-sm text-muted-foreground">
				Click the right side for the next slide, the left side to go back. Arrow
				keys work too.
			</p>
			<output aria-live="polite" className="sr-only">
				{`Slide ${index + 1} of ${SLIDES.length}: ${slide.title}`}
			</output>
		</section>
	);
}
