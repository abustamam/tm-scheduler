import { QRCodeSVG } from "qrcode.react";
import type { Body } from "#/lib/slide-layout";

// The deck's palette (see `meeting-present.tsx`), restated for the two this
// body uses: importing them from there would make the presenter and this module
// import each other.
const MAROON = "#770D29";
const MUTED = "#565656";

export type RosterBody = Extract<Body, { form: "roster" }>;

/**
 * The "What's on tap for next meeting" slide's body (#932), on screen.
 *
 * Styled with INLINE styles in `cqw`, not Tailwind classes, and that is what
 * makes it measurable: `next-meeting-slide-geometry.test.ts` renders this exact
 * component to static markup and lays it out in a real browser at the deck's
 * 1280x720 body box, with no stylesheet to inline. A class-based body could
 * only be measured through a synthetic copy of its markup.
 *
 * Everything it shows was loaded with the deck — the QR is a static URL — so it
 * renders complete on a presenting laptop with no network (#932).
 */
export function NextMeetingBodyView({ body }: { body: RosterBody }) {
	const half = Math.ceil(body.rows.length / 2);
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: "1cqw" }}>
			{/* The lead block, with the QR beside it rather than beside the whole
			    body: the role columns below then get the full width, and a role
			    holder's name stays on one line instead of wrapping in a column a
			    third narrower. MEASURED — see the geometry suite. */}
			<div style={{ display: "flex", alignItems: "center", gap: "3cqw" }}>
				<div
					style={{
						flex: 1,
						minWidth: 0,
						display: "flex",
						flexDirection: "column",
						gap: "0.7cqw",
					}}
				>
					<div style={{ fontSize: "2cqw", fontWeight: 600, lineHeight: 1.2 }}>
						{body.when}
					</div>
					{body.toastmaster ? (
						<div
							style={{ fontSize: "2.8cqw", fontWeight: 800, lineHeight: 1.15 }}
							data-testid="next-meeting-toastmaster"
						>
							<RowText row={body.toastmaster} />
						</div>
					) : null}
					{body.meta ? (
						<div style={{ fontSize: "1.8cqw", lineHeight: 1.25, color: MUTED }}>
							{body.meta}
						</div>
					) : null}
				</div>
				{body.qr ? (
					<div
						style={{
							display: "flex",
							flexDirection: "column",
							alignItems: "center",
							gap: "0.6cqw",
						}}
					>
						{/* White plate for the same reason as the vote slides' QR: pure
						    white is the one background guaranteed to scan off a
						    projector in a dimmed room. */}
						<div
							style={{
								background: "#ffffff",
								padding: "0.7cqw",
								borderRadius: "0.8cqw",
							}}
							data-testid="next-meeting-qr"
						>
							<QRCodeSVG
								value={body.qr.url}
								marginSize={0}
								style={{ display: "block", width: "9cqw", height: "9cqw" }}
							/>
						</div>
						<p
							style={{
								margin: 0,
								fontSize: "1.5cqw",
								fontWeight: 600,
								lineHeight: 1.2,
							}}
						>
							{body.qr.caption}
						</p>
					</div>
				) : null}
			</div>
			{body.rows.length > 0 ? (
				// Down the columns, not across the rows, so the roles read in agenda
				// order the way a printed two-column roster does.
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
						gridTemplateRows: `repeat(${half}, auto)`,
						gridAutoFlow: "column",
						columnGap: "2.5cqw",
						rowGap: "0.5cqw",
						fontSize: "1.8cqw",
						lineHeight: 1.2,
					}}
				>
					{body.rows.map((row, idx) => (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: two roles can share a label
							key={idx}
							data-testid="next-meeting-role"
						>
							<RowText row={row} />
						</div>
					))}
				</div>
			) : null}
			{body.openList ? (
				<div
					style={{
						fontSize: "2cqw",
						fontWeight: 800,
						lineHeight: 1.3,
						color: MAROON,
					}}
				>
					{body.openList}
				</div>
			) : null}
			{body.filled ? (
				<div style={{ fontSize: "1.6cqw", lineHeight: 1.3, color: MUTED }}>
					{body.filled}
				</div>
			) : null}
		</div>
	);
}

function RowText({
	row,
}: {
	row: { label: string; names: string | null; open: string | null };
}) {
	return (
		<>
			<span style={{ fontWeight: 800 }}>{row.label}:</span>
			{row.names ? ` ${row.names}` : null}
			{row.open ? (
				<span style={{ fontWeight: 800, color: MAROON }}> {row.open}</span>
			) : null}
		</>
	);
}
