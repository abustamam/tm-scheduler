import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { ToastmastersWordmark } from "#/components/agenda/toastmasters-wordmark";
import { PptxDownloadButton } from "#/components/club/pptx-download-button";
import type { Slide } from "#/lib/agenda-slides";
import { TOASTMASTERS_DISCLAIMER } from "#/lib/brand";
import {
	footerDate,
	type Line,
	type SlideLayout,
	slideLayout,
} from "#/lib/slide-layout";

// Official brand palette (sampled from the wordmark) so chrome matches the logo.
const INK = "#2b2b2b";
const MAROON = "#770D29";
const NAVY = "#004062";
const GROUND = "#f3f4f4";
const MUTED = "#565656";
const GOLD = "#f3dd94";
const NAVY_GRADIENT_TOP = "#0a4f78";
const NAVY_GRADIENT_BOTTOM = "#002a41";

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
				if (document.fullscreenElement) document.exitFullscreen();
				else onExit?.();
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [next, prev, onExit]);

	const slide = deck[i];
	const layout = slideLayout(slide);
	const title = deck.find((s) => s.kind === "title");
	const fdate = title ? footerDate(title.scheduledAt, title.timezone) : "";

	return (
		<div className="fixed inset-0 flex items-center justify-center bg-black">
			<div className="absolute top-[2vmin] right-[2vmin] z-20">
				<PptxDownloadButton deck={deck} clubName={clubName} />
			</div>
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

			{/* Letterboxed 16:9 frame so screen matches the .pptx exactly. */}
			<div
				className="relative"
				style={{
					aspectRatio: "16 / 9",
					width: "min(100vw, calc(100vh * 16 / 9))",
					containerType: "inline-size",
				}}
			>
				{layout.chrome === "splash" ? (
					<Splash layout={layout} />
				) : (
					<ContentSlide layout={layout} clubName={clubName} date={fdate} />
				)}
			</div>

			<div className="absolute bottom-[1.5vmin] left-1/2 -translate-x-1/2 text-[1.6vmin] text-white/70 tabular-nums">
				{i + 1} / {deck.length}
			</div>
		</div>
	);
}

/** Scale the body to fit its box when content would otherwise overflow the fixed
 *  16:9 frame (guard for long outliers: definitions, reminders, big rosters).
 *  Uses transform (layout-independent) so measurement is on the natural size and
 *  the shrink actually cascades — unlike a font-size change, which cqw ignores. */
function useFitTransform(deps: unknown[]) {
	const outer = useRef<HTMLDivElement>(null);
	const inner = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const o = outer.current;
		const n = inner.current;
		if (!o || !n) return;
		n.style.transform = "none";
		const sw = n.scrollWidth;
		const sh = n.scrollHeight;
		if (!sw || !sh) return;
		const k = Math.min(1, o.clientWidth / sw, o.clientHeight / sh);
		n.style.transform = k < 1 ? `scale(${k})` : "none";
		// biome-ignore lint/correctness/useExhaustiveDependencies: deps drive re-measure per slide
	}, deps);
	return { outer, inner };
}

function Splash({
	layout,
}: {
	layout: Extract<SlideLayout, { chrome: "splash" }>;
}) {
	const dark = layout.tone === "dark";
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
			<ToastmastersWordmark
				tone={dark ? "white" : "color"}
				style={{ width: dark ? "21cqw" : "25cqw" }}
			/>
			<div
				className="my-[3.4cqw] h-px w-[58cqw]"
				style={{ background: dark ? "rgba(255,255,255,.55)" : NAVY }}
			/>
			<div
				className="text-[6.4cqw] font-extrabold leading-tight text-balance"
				style={{ color: dark ? GOLD : INK }}
			>
				{layout.headline}
			</div>
			<div className="mt-[2.6cqw] flex flex-col gap-[0.7cqw]">
				{layout.sub.map((l, idx) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: sub lines have no stable id and can repeat (e.g. two spacers)
					<LineView key={idx} line={l} splash />
				))}
			</div>
		</div>
	);
}

function ContentSlide({
	layout,
	clubName,
	date,
}: {
	layout: Extract<SlideLayout, { chrome: "content" }>;
	clubName: string;
	date: string;
}) {
	const { outer, inner } = useFitTransform([layout]);
	return (
		<div
			className="flex h-full w-full flex-col"
			style={{ background: GROUND, color: INK }}
		>
			<header className="px-[6cqw] pt-[5cqw]">
				<div className="text-[3.9cqw] font-extrabold leading-tight">
					{layout.header}
				</div>
				<div
					className="mt-[1.5cqw] h-[0.7cqw] w-[8cqw] rounded"
					style={{ background: MAROON }}
				/>
			</header>
			<div
				ref={outer}
				className="flex min-h-0 flex-1 flex-col justify-center overflow-hidden px-[7cqw] py-[2.5cqw]"
			>
				<div ref={inner} className="w-full">
					<BodyView body={layout.body} />
				</div>
			</div>
			<footer
				className="flex h-[8.5cqw] flex-col justify-center gap-[0.7cqw] px-[5cqw]"
				style={{ background: NAVY }}
			>
				<div className="flex items-center justify-between">
					<ToastmastersWordmark tone="white" style={{ width: "13cqw" }} />
					<div className="text-right leading-tight text-white">
						<div className="text-[2.4cqw] font-bold">{clubName}</div>
						<div className="text-[2cqw] opacity-90">{date}</div>
					</div>
				</div>
				<p className="text-center text-[1.05cqw] leading-tight text-white/50">
					{TOASTMASTERS_DISCLAIMER}
				</p>
			</footer>
		</div>
	);
}

function BodyView({
	body,
}: {
	body: Extract<SlideLayout, { chrome: "content" }>["body"];
}) {
	if (body.form === "word") {
		return (
			<div className="text-center">
				<div className="text-[8.6cqw] leading-none">{body.word}</div>
				{body.definition ? (
					<div
						className="mt-[4cqw] text-[2.9cqw] leading-snug"
						style={{ color: MUTED }}
					>
						{body.definition}
					</div>
				) : null}
				{body.example ? (
					<div
						className="mt-[3.4cqw] text-[2.9cqw] italic leading-snug"
						style={{ color: MUTED }}
					>
						{`“${body.example}”`}
					</div>
				) : null}
			</div>
		);
	}
	if (body.form === "bullets") {
		return (
			<div className="flex flex-col gap-[3cqw]">
				{body.items.map((t, idx) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: bullet items have no stable id and can repeat
						key={idx}
						className="flex gap-[1.6cqw] text-[4.3cqw] font-extrabold leading-tight"
					>
						<span>•</span>
						<span>{t}</span>
					</div>
				))}
				{body.link ? (
					<div className="flex gap-[1.6cqw] text-[4.3cqw] font-extrabold leading-tight">
						<span>•</span>
						<span>
							Link:{" "}
							<a
								href={body.link}
								target="_blank"
								rel="noreferrer noopener"
								// relative z-30 lifts the link above the invisible prev/next
								// nav click-zones (z-10) so it stays clickable during projection.
								className="relative z-30 underline"
								style={{ color: NAVY }}
							>
								Presentation
							</a>
						</span>
					</div>
				) : null}
			</div>
		);
	}
	if (body.form === "numbered") {
		return (
			<div className="flex flex-col gap-[3cqw]">
				{body.items.map((t, idx) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: numbered items have no stable id and can repeat
						key={idx}
						className="flex gap-[2cqw] text-[5cqw] font-extrabold leading-tight"
					>
						<span className="tabular-nums">{idx + 1}.</span>
						<span>{t}</span>
					</div>
				))}
			</div>
		);
	}
	return (
		<div className="flex flex-col items-center gap-[2.6cqw] text-center">
			{body.lines.map((l, idx) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: centered lines have no stable id and can repeat (e.g. two spacers)
				<LineView key={idx} line={l} />
			))}
		</div>
	);
}

function LineView({ line, splash }: { line: Line; splash?: boolean }) {
	if (line.role === "spacer") return <div className="h-[2.4cqw]" />;
	if (line.role === "name")
		return (
			<div className="text-[4.2cqw] font-extrabold leading-tight">{`•  ${line.text}`}</div>
		);
	if (line.role === "muted")
		return (
			<div
				className="text-[2.5cqw] leading-snug"
				style={splash ? undefined : { color: MUTED }}
			>
				{line.text}
			</div>
		);
	if (line.role === "strong")
		return (
			<div className="text-[2.8cqw] font-semibold leading-tight">
				{line.text}
			</div>
		);
	return (
		<div className="text-[5cqw] font-extrabold leading-tight text-balance">
			{line.text}
		</div>
	);
}
