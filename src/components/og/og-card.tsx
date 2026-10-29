/**
 * The satori JSX for the generated link-preview cards (#1411): 1200x630.
 *
 * Satori is not a browser. Every element with more than one child needs
 * `display: flex`, styles are inline, and a font family must be one registered
 * with `satori()` (`og-card-logic.ts`). The tokens are the flyer square's, from
 * `print-theme.tsx` and `meeting-flyer.tsx`.
 *
 * PRIVACY: a card is drawn from `MeetingCardView` / `ClubCardView` only. They
 * hold officer-entered strings and nothing about a person.
 */
import {
	FLYER_CANCELLED_INK,
	FLYER_CANCELLED_LABEL,
} from "#/components/agenda/meeting-flyer";
import {
	FOREST,
	INK,
	MINT,
	MUTED,
	SAND,
	SANS,
	SERIF,
} from "#/components/agenda/print-theme";

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

export interface MeetingCardView {
	clubName: string;
	/** `data:` URL of the club logo, or of the GavelUp mark. */
	logoSrc: string;
	/** "Thu, Nov 5, 7:00 PM", already in the club's timezone. */
	when: string;
	theme: string | null;
	/** Location, "Online", or null. */
	where: string | null;
	word: string | null;
	cancelled: boolean;
}

export interface ClubCardView {
	clubName: string;
	logoSrc: string;
	/** "Thu, Nov 5, 7:00 PM", or null with no upcoming meeting. */
	nextWhen: string | null;
	nextTheme: string | null;
}

export const SIGN_UP_LINE = "Sign up for meeting roles";

const FRAME = {
	display: "flex",
	width: OG_WIDTH,
	height: OG_HEIGHT,
	backgroundColor: MINT,
	fontFamily: SANS,
	color: INK,
	position: "relative",
} as const;

function Brand({ clubName, logoSrc }: { clubName: string; logoSrc: string }) {
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "center",
				width: 400,
				height: OG_HEIGHT,
				backgroundColor: SAND,
				padding: 40,
			}}
		>
			{/* biome-ignore lint/a11y/useAltText: satori renders to a PNG; there is no DOM */}
			<img
				src={logoSrc}
				width={220}
				height={220}
				style={{ objectFit: "contain" }}
			/>
			<div
				style={{
					display: "flex",
					marginTop: 32,
					fontFamily: SERIF,
					fontWeight: 600,
					fontSize: 40,
					lineHeight: 1.15,
					textAlign: "center",
					color: FOREST,
					lineClamp: 2,
					maxWidth: 320,
				}}
			>
				{clubName}
			</div>
		</div>
	);
}

function Line({
	text,
	size,
	clamp,
	weight = 400,
	color = MUTED,
	serif = false,
}: {
	text: string;
	size: number;
	clamp: number;
	weight?: 400 | 600 | 700;
	color?: string;
	serif?: boolean;
}) {
	return (
		<div
			style={{
				display: "flex",
				fontFamily: serif ? SERIF : SANS,
				fontWeight: weight,
				fontSize: size,
				lineHeight: 1.2,
				color,
				lineClamp: clamp,
				maxWidth: 700,
				marginTop: 14,
			}}
		>
			{text}
		</div>
	);
}

export function MeetingCard({ view }: { view: MeetingCardView }) {
	return (
		<div style={FRAME}>
			<Brand clubName={view.clubName} logoSrc={view.logoSrc} />
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					justifyContent: "center",
					width: 800,
					height: OG_HEIGHT,
					padding: "40px 50px",
				}}
			>
				{view.theme ? (
					<>
						<Line
							text={view.theme}
							size={56}
							clamp={3}
							weight={600}
							serif
							color={INK}
						/>
						<Line
							text={view.when}
							size={32}
							clamp={1}
							weight={700}
							color={FOREST}
						/>
					</>
				) : (
					<Line
						text={view.when}
						size={56}
						clamp={3}
						weight={600}
						serif
						color={INK}
					/>
				)}
				{view.where ? <Line text={view.where} size={28} clamp={1} /> : null}
				{view.word ? (
					<Line text={`Word of the Day: ${view.word}`} size={28} clamp={1} />
				) : null}
			</div>
			{view.cancelled ? <CancelledStamp /> : null}
		</div>
	);
}

export function ClubCard({ view }: { view: ClubCardView }) {
	return (
		<div style={FRAME}>
			<Brand clubName={view.clubName} logoSrc={view.logoSrc} />
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					justifyContent: "center",
					width: 800,
					height: OG_HEIGHT,
					padding: "40px 50px",
				}}
			>
				<Line
					text={SIGN_UP_LINE}
					size={56}
					clamp={2}
					weight={600}
					serif
					color={INK}
				/>
				{view.nextWhen ? (
					<Line
						text={`Next meeting: ${view.nextWhen}`}
						size={32}
						clamp={1}
						weight={700}
						color={FOREST}
					/>
				) : null}
				{view.nextWhen && view.nextTheme ? (
					<Line text={view.nextTheme} size={28} clamp={2} />
				) : null}
			</div>
		</div>
	);
}

/** The static fallback and the `/public/og/default.png` source. */
export function DefaultCard({ markSrc }: { markSrc: string }) {
	return (
		<div style={{ ...FRAME, alignItems: "center", justifyContent: "center" }}>
			{/* biome-ignore lint/a11y/useAltText: satori renders to a PNG; there is no DOM */}
			<img src={markSrc} width={200} height={200} />
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					marginLeft: 56,
					width: 700,
				}}
			>
				<div
					style={{
						display: "flex",
						fontFamily: SERIF,
						fontWeight: 600,
						fontSize: 96,
						color: FOREST,
					}}
				>
					GavelUp
				</div>
				<div
					style={{ display: "flex", fontSize: 36, color: INK, marginTop: 12 }}
				>
					The meeting runner for Toastmasters clubs
				</div>
			</div>
		</div>
	);
}

function CancelledStamp() {
	return (
		<div
			style={{
				position: "absolute",
				top: 0,
				left: 0,
				width: OG_WIDTH,
				height: OG_HEIGHT,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
			}}
		>
			<div
				style={{
					display: "flex",
					border: `8px solid ${FLYER_CANCELLED_INK}`,
					color: FLYER_CANCELLED_INK,
					backgroundColor: "rgba(255,255,255,0.88)",
					padding: "12px 48px",
					borderRadius: 16,
					fontSize: 96,
					fontWeight: 700,
					textTransform: "uppercase",
					transform: "rotate(-10deg)",
				}}
			>
				{FLYER_CANCELLED_LABEL}
			</div>
		</div>
	);
}
