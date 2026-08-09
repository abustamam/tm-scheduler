import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { ClubLogo } from "#/components/agenda/club-logo";
import { PptxDownloadButton } from "#/components/club/pptx-download-button";
import type { Slide } from "#/lib/agenda-slides";
import { TOASTMASTERS_DISCLAIMER } from "#/lib/brand";
import {
	footerDate,
	type Line,
	type SlideLayout,
	slideLayout,
	slideName,
} from "#/lib/slide-layout";
import { getVoteParticipation } from "#/server/voting";

// Official brand palette (sampled from the wordmark) so chrome matches the logo.
const INK = "#2b2b2b";
const MAROON = "#770D29";
const NAVY = "#004062";
const GROUND = "#f3f4f4";
const MUTED = "#565656";
const GOLD = "#f3dd94";
const NAVY_GRADIENT_TOP = "#0a4f78";
const NAVY_GRADIENT_BOTTOM = "#002a41";

/** Overview grid width. Fixed rather than responsive so ↑/↓ move by exactly one
 *  row, and so the row arithmetic lives in one place the tests can pin. Row
 *  moves are keyboard-only on purpose: the presenter remotes this feature exists
 *  for have no ↑/↓ at all — see the key map in the overview branch of `onKey`. */
const OVERVIEW_COLUMNS = 4;

/** The name a slide answers to in the overview: the same header the audience
 *  reads off it, straight from `slideName` — never a parallel naming scheme that
 *  could drift from what is projected. Re-exported under the local name the JSX
 *  reads by; the derivation itself lives with `slideLayout` so the cross-kind
 *  uniqueness this grid depends on is asserted against it, not a copy (#446). */
const slideLabel = slideName;

/** The three vote slide kinds (#510). Named rather than matched on a "vote"
 *  prefix — `agenda-parity.test.ts` draws the same line for the same reason:
 *  a future kind starting with "vote" but carrying no ballot would otherwise
 *  slip through and read `undefined` instead of failing to compile. */
type VoteSlide = Extract<
	Slide,
	{ kind: "voteSpeaker" | "voteTableTopics" | "voteEvaluator" }
>;
const isVoteSlide = (s: Slide): s is VoteSlide =>
	s.kind === "voteSpeaker" ||
	s.kind === "voteTableTopics" ||
	s.kind === "voteEvaluator";

/** The award category `getVoteParticipation` keys its bare counts by, for one
 *  vote slide kind. A string-literal union rather than the server's own
 *  `AwardCategory` (`#/server/minutes-logic`, a `*-logic.ts` db module) —
 *  structurally identical, so it types the same `categories` lookup, without a
 *  client component reaching past `voting.ts`'s own re-exported types into the
 *  db-logic module those exist to keep out of the bundle (see
 *  `server-modules.guard.test.ts` and the comment atop `voting.ts`). */
function voteCategory(
	kind: VoteSlide["kind"],
): "best_speaker" | "best_evaluator" | "best_table_topics" {
	if (kind === "voteSpeaker") return "best_speaker";
	if (kind === "voteEvaluator") return "best_evaluator";
	return "best_table_topics";
}

/** Full-screen, keyboard-driven slideshow. Read-only; position is local state. */
export function MeetingPresent({
	deck,
	clubName,
	meetingId,
	onExit,
	offlineBadge,
}: {
	deck: Slide[];
	clubName: string;
	/** The meeting's real DB id (#510) — distinct from the pretty URL key the
	 *  route resolves. Used only to poll `getVoteParticipation` for the
	 *  projector's bare-count badge, the same id the Ballot Counter console
	 *  keys its own (gated, per-candidate) tally query on. */
	meetingId: string;
	onExit?: () => void;
	/** Connectivity indicator, rendered in the top-right chrome cluster beside
	 *  the .pptx button rather than over the slide (#361). */
	offlineBadge?: ReactNode;
}) {
	const [i, setI] = useState(0);
	// The overview is closed until asked for (#360): the meeting sees the deck
	// and nothing else. `cursor` is the highlighted card while it is open —
	// separate from `i` so browsing the list does not move the projection until
	// the presenter commits.
	const [overview, setOverview] = useState(false);
	const [cursor, setCursor] = useState(0);
	// A BARE COUNT, never per-candidate numbers (#510): a live leaderboard on
	// the projector produces bandwagon voting and destroys the reveal —
	// per-candidate tallies exist only behind the gated `getVoteTally`. Polls
	// regardless of which slide is showing, the same steady background
	// presence `OfflineBadge` keeps, so the count is current the moment the
	// presenter flips to a vote slide rather than one 5-second beat late.
	const participation = useQuery({
		queryKey: ["vote-participation", meetingId],
		queryFn: () => getVoteParticipation({ data: { meetingId } }),
		refetchInterval: 5000,
	});
	/** "7 votes in", or "7 of 12 present have voted" once attendance is marked.
	 *  `presentCount` is null until then — the server cannot know who is in the
	 *  room until someone votes, so the honest denominator is none; rendering
	 *  it anyway would show "7 of 0". */
	function participationLabel(kind: VoteSlide["kind"]): string {
		const p = participation.data;
		const n = p?.categories[voteCategory(kind)]?.ballotsIn ?? 0;
		return p?.presentCount != null
			? `${n} of ${p.presentCount} present have voted`
			: `${n} ${n === 1 ? "vote" : "votes"} in`;
	}
	const last = deck.length - 1;
	const next = useCallback(() => setI((n) => Math.min(n + 1, last)), [last]);
	const prev = useCallback(() => setI((n) => Math.max(n - 1, 0)), []);

	const openOverview = useCallback(() => {
		setCursor(i);
		setOverview(true);
	}, [i]);
	const jumpTo = useCallback((n: number) => {
		setI(n);
		setOverview(false);
	}, []);

	const labels = useMemo(() => deck.map(slideLabel), [deck]);

	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			const k = e.key;
			// Fullscreen is orthogonal to both modes.
			if (k === "f" || k === "F") {
				if (document.fullscreenElement) document.exitFullscreen();
				else document.documentElement.requestFullscreen?.();
				return;
			}
			if (overview) {
				// The key map is built for the hardware, not the laptop. A Logitech
				// R400/R800 — and the clones that copy it — sends PageDown/PageUp for
				// forward/back, `b` for blank screen, and F5/Esc off the start/stop
				// button. No Enter, no Space, no ↑/↓. So:
				//   · PageDown/PageUp keep the meaning they carry on the deck (±1
				//     slide), applied to the cursor. ←/→ are the same move.
				//   · ↑/↓ move a whole row. Keyboard-only, by necessity.
				//   · `b`/`o` — the only button the remote has left — commits, which
				//     is what makes the grid usable from the back of the room.
				// Commit is safe as the single "done" key because `openOverview` seeds
				// the cursor to the current slide: open and close without moving and
				// the jump is to where you already were, i.e. an unchanged close. To
				// back out AFTER browsing, discard the cursor with Escape or the ✕.
				// Escape stays bound for muscle memory but is deliberately absent from
				// the on-screen hint: a browser leaves fullscreen on Escape whatever
				// `preventDefault` says, so telling a presenter it is the safe dismiss
				// would drop the projector to the desktop mid-meeting.
				if (k === "Escape") {
					e.preventDefault();
					setOverview(false);
				} else if (k === "b" || k === "B" || k === "o" || k === "O") {
					e.preventDefault();
					jumpTo(cursor);
				} else if (k === "ArrowRight" || k === "PageDown") {
					e.preventDefault();
					setCursor((c) => Math.min(c + 1, last));
				} else if (k === "ArrowLeft" || k === "PageUp") {
					e.preventDefault();
					setCursor((c) => Math.max(c - 1, 0));
				} else if (k === "ArrowDown") {
					e.preventDefault();
					setCursor((c) => Math.min(c + OVERVIEW_COLUMNS, last));
				} else if (k === "ArrowUp") {
					e.preventDefault();
					setCursor((c) => Math.max(c - OVERVIEW_COLUMNS, 0));
				} else if (k === "Enter" || k === " ") {
					e.preventDefault();
					jumpTo(cursor);
				}
				return;
			}
			if (k === "ArrowRight" || k === "PageDown" || k === " ") {
				e.preventDefault();
				next();
			} else if (k === "ArrowLeft" || k === "PageUp") {
				e.preventDefault();
				prev();
			} else if (k === "b" || k === "B" || k === "o" || k === "O") {
				// `b`/`o` is the presenter-tool convention (PowerPoint, Keynote,
				// reveal.js all put the slide overview behind one of the two).
				e.preventDefault();
				openOverview();
			} else if (k === "Escape") {
				if (document.fullscreenElement) document.exitFullscreen();
				else onExit?.();
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [next, prev, onExit, overview, cursor, last, openOverview, jumpTo]);

	const slide = deck[i];
	const layout = slideLayout(slide);
	const title = deck.find((s) => s.kind === "title");
	const fdate = title ? footerDate(title.scheduledAt, title.timezone) : "";
	// Read off the deck rather than taken as a prop: the splash already renders
	// from `layout.logoUrl`, and a second prop carrying the same value is a
	// place the two can disagree.
	const logoUrl = title?.logoUrl ?? null;
	// The QR + badge (#510) — null on every non-vote slide, which `ContentSlide`
	// reads as "render the body alone, exactly as before".
	const vote = isVoteSlide(slide)
		? { ballotUrl: slide.ballotUrl, label: participationLabel(slide.kind) }
		: null;

	return (
		<div className="fixed inset-0 flex items-center justify-center bg-black">
			<div className="absolute top-[2vmin] right-[2vmin] z-20 flex items-center gap-[1.2vmin]">
				{offlineBadge}
				<PptxDownloadButton deck={deck} clubName={clubName} logoUrl={logoUrl} />
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
					<ContentSlide
						layout={layout}
						clubName={clubName}
						date={fdate}
						vote={vote}
					/>
				)}
			</div>

			{/* Top-center: the one region empty on both splash and content slides.
			    Bottom-center would sit on the footer's centered trademark
			    disclaimer; top-right holds the PPTX button, top-left the content
			    header. The dark pill keeps it legible over both the light content
			    ground and the dark splash.

			    It doubles as the overview's mouse affordance: the counter already
			    reads "where am I in the deck", so making it clickable adds the
			    "take me somewhere else" answer without putting a single new pixel
			    on the projection (#360).

			    Deliberately NOT z-20. The offline banner (#361) is mounted inside
			    the z-20 top-right cluster and pins itself top-center; a second
			    z-20 sibling later in the DOM wins the tie and paints this pill
			    straight across "Offline · showing the agenda as of …" — the one
			    message a presenter on a dropped wifi needs to read. Leaving it
			    unlayered puts it back under the banner. It stays clickable: the
			    invisible prev/next zones (z-10) are the left/right quarters and a
			    centered pill this narrow never reaches them. */}
			<button
				type="button"
				onClick={openOverview}
				title="Jump to a slide (B)"
				aria-label={`Slide ${i + 1} of ${deck.length} — jump to a slide`}
				aria-haspopup="dialog"
				className="absolute top-[2vmin] left-1/2 -translate-x-1/2 cursor-pointer rounded-full bg-black/35 px-[1.4vmin] py-[0.3vmin] text-[1.6vmin] text-white/90 tabular-nums"
			>
				{i + 1} / {deck.length}
			</button>

			{overview ? (
				<SlideOverview
					labels={labels}
					current={i}
					cursor={cursor}
					onPick={jumpTo}
					onClose={() => setOverview(false)}
				/>
			) : null}
		</div>
	);
}

/** The jump-to-slide grid. Mounted only while open, so normal projection is
 *  byte-for-byte what it was before. Everything it needs is already in memory
 *  — no fetch, so it works from the service worker's cached bundle mid-meeting. */
function SlideOverview({
	labels,
	current,
	cursor,
	onPick,
	onClose,
}: {
	labels: string[];
	current: number;
	cursor: number;
	onPick: (n: number) => void;
	onClose: () => void;
}) {
	const cursorRef = useRef<HTMLButtonElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: cursor re-points the ref rather than appearing in the body
	useEffect(() => {
		// Follow the highlight: focus keeps `aria-modal` honest (tab order starts
		// inside the overview) and long decks scroll, so the keyboard cursor has
		// to be brought on screen. Optional calls — jsdom leaves `scrollIntoView`
		// undefined.
		cursorRef.current?.focus?.({ preventScroll: true });
		cursorRef.current?.scrollIntoView?.({ block: "nearest" });
	}, [cursor]);

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Jump to a slide"
			className="absolute inset-0 z-40 flex flex-col bg-black/95 px-[4vmin] py-[3vmin] text-white"
		>
			<div className="flex items-center justify-between gap-[2vmin]">
				<div className="text-[2.4vmin] font-extrabold">Jump to a slide</div>
				<div className="flex items-center gap-[2vmin]">
					{/* Never advertise Escape here. It closes the overview, but it is
					    also a browser-level fullscreen exit that `preventDefault`
					    cannot cancel, so a presenter who follows this hint drops the
					    projector to the tab strip and the OS taskbar in front of the
					    room. B is both the way out and the way to commit, and it is
					    the one the remote in their hand can actually press. */}
					<span className="text-[1.5vmin] text-white/60">
						← → browse · B or Enter go · ✕ cancel
					</span>
					<button
						type="button"
						aria-label="Cancel and stay on the current slide"
						onClick={onClose}
						className="rounded-full bg-white/10 p-[1vmin] text-white/80 hover:bg-white/20"
					>
						<X className="size-[2vmin]" aria-hidden />
					</button>
				</div>
			</div>
			<div
				className="mt-[2.5vmin] grid min-h-0 flex-1 auto-rows-min gap-[1.5vmin] overflow-y-auto"
				style={{
					gridTemplateColumns: `repeat(${OVERVIEW_COLUMNS}, minmax(0, 1fr))`,
				}}
			>
				{labels.map((label, idx) => (
					<button
						// biome-ignore lint/suspicious/noArrayIndexKey: position IS the identity here — headers legitimately repeat, one "Speech Evaluation" per evaluator
						key={idx}
						ref={idx === cursor ? cursorRef : null}
						type="button"
						aria-label={`Slide ${idx + 1}: ${label}`}
						aria-current={idx === current ? "true" : undefined}
						onClick={() => onPick(idx)}
						className="flex items-center gap-[1.4vmin] rounded-[1.2vmin] border px-[1.6vmin] py-[1.4vmin] text-left"
						style={{
							borderColor: idx === cursor ? GOLD : "rgba(255,255,255,.18)",
							background:
								idx === cursor
									? "rgba(255,255,255,.14)"
									: "rgba(255,255,255,.06)",
						}}
					>
						<span
							className="shrink-0 rounded-[0.8vmin] px-[1.1vmin] py-[0.3vmin] text-[1.6vmin] font-bold tabular-nums"
							style={{
								background: idx === current ? MAROON : "rgba(255,255,255,.12)",
							}}
						>
							{idx + 1}
						</span>
						<span className="min-w-0 text-[1.9vmin] font-semibold leading-tight">
							{label}
						</span>
					</button>
				))}
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
			{/* The club's OWN uploaded logo, above the program name it belongs to.
			    Sized in cqw like everything else on a slide, so it scales with
			    whatever this is projected onto. Renders nothing when the club has
			    no logo, leaving the splash exactly as it was. */}
			<ClubLogo
				logoUrl={layout.logoUrl ?? null}
				height="9cqw"
				maxWidth="46cqw"
			/>
			{/* Nominative word use, not the official wordmark image (ADR-0024). */}
			<div
				className="font-display font-semibold tracking-[-0.01em]"
				style={{
					fontSize: "6cqw",
					color: dark ? "#ffffff" : NAVY,
					marginTop: layout.logoUrl ? "2.2cqw" : undefined,
				}}
			>
				Toastmasters
			</div>
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
	vote,
}: {
	layout: Extract<SlideLayout, { chrome: "content" }>;
	clubName: string;
	date: string;
	/** Non-null only on the three vote slides (#510). `null` renders the body
	 *  exactly as every other content slide always has. */
	vote: { ballotUrl: string; label: string } | null;
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
					{vote ? (
						<div className="flex items-center gap-[4cqw]">
							<div className="flex-1">
								<BodyView body={layout.body} />
							</div>
							<div className="flex flex-col items-center gap-[1cqw]">
								{/* White padded — NOT decoration. This chrome's own background
								    (`GROUND`, off-white) already gives the QR's black modules
								    contrast, but the room around a projector is dark for
								    exactly the vote beat this slide is for, and the exported
								    .pptx or a phone's camera under low ambient light shouldn't
								    have to rely on a screen calibrating `#f3f4f4` as "light
								    enough" — pure white is the one background guaranteed to
								    scan, the same reasoning the guest-book QR (VP Membership)
								    already pins its own paper to. */}
								<div className="rounded-[1.2cqw] bg-white p-[1.2cqw]">
									{/* `ballotUrl` is `""` for one render on mount, before the
									    present route's origin effect fires (#510) — an empty
									    value QR-encodes without error but scans to nothing, so
									    it's withheld rather than shown and immediately swapped. */}
									{vote.ballotUrl ? (
										<QRCodeSVG
											value={vote.ballotUrl}
											size={220}
											marginSize={0}
										/>
									) : (
										<div style={{ width: 220, height: 220 }} />
									)}
								</div>
								<p className="text-[2.2cqw] font-semibold">Scan to vote</p>
								{/* A BARE COUNT. Never per-candidate numbers on the projector
								    (#510) — see `MeetingPresent`'s own comment on `participation`. */}
								<p className="text-[1.7cqw] opacity-70">{vote.label}</p>
							</div>
						</div>
					) : (
						<BodyView body={layout.body} />
					)}
				</div>
			</div>
			<footer
				className="flex h-[8.5cqw] flex-col justify-center gap-[0.7cqw] px-[5cqw]"
				style={{ background: NAVY }}
			>
				<div className="flex items-center justify-between">
					{/* GavelUp origin mark on deck chrome (ADR-0024). */}
					<div
						className="font-display font-semibold text-white"
						style={{ fontSize: "2.8cqw" }}
					>
						GavelUp
					</div>
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
				{body.presenter ? (
					<div
						className="mt-[3.4cqw] text-[2.2cqw] leading-snug"
						style={{ color: MUTED }}
					>
						{body.presenter}
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
				{body.note ? (
					// Pulled up under the last bullet and indented past its marker, so
					// the note reads as belonging to that line rather than floating as
					// a fifth item (#355).
					<div
						className="-mt-[1.6cqw] pl-[3.4cqw] text-[2.5cqw] leading-snug"
						style={{ color: MUTED }}
					>
						{body.note}
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
