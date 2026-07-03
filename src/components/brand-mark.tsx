/**
 * The GavelUp brand mark: a stroke-based gavel glyph in a gradient chip, next to
 * the "GavelUp" wordmark in the Fraunces display face. Shared by the authed
 * sidebar (`_authed.tsx`) and the public club shell (`club.$clubId.tsx`).
 */

/** The raw gavel SVG. Sized by the caller via width/height. */
export function GavelGlyph({ size = 20 }: { size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="#fff"
			strokeWidth="2.1"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden
		>
			<title>GavelUp</title>
			<path d="M3 21h9" />
			<path d="m13.5 6.5-7 7" />
			<rect
				x="11.5"
				y="2.6"
				width="6"
				height="3.4"
				rx="1.2"
				transform="rotate(45 14.5 4.3)"
			/>
			<rect
				x="16.2"
				y="7.3"
				width="6"
				height="3.4"
				rx="1.2"
				transform="rotate(45 19.2 9)"
			/>
		</svg>
	);
}

type BrandMarkSize = "sm" | "md";

const SIZES: Record<
	BrandMarkSize,
	{ chip: string; glyph: number; wordmark: string }
> = {
	// `md` reproduces the authed sidebar mark byte-for-byte.
	md: {
		chip: "size-[38px] rounded-[11px]",
		glyph: 20,
		wordmark: "text-[19px]",
	},
	// `sm` is a slightly smaller variant for the public shell header.
	sm: {
		chip: "size-[30px] rounded-[9px]",
		glyph: 16,
		wordmark: "text-[16px]",
	},
};

export function BrandMark({
	size = "md",
	subtitle,
}: {
	size?: BrandMarkSize;
	subtitle?: React.ReactNode;
}) {
	const s = SIZES[size];
	return (
		<div className="flex items-center gap-[11px]">
			<span
				className={`flex shrink-0 items-center justify-center bg-[linear-gradient(150deg,var(--lagoon),var(--lagoon-deep))] shadow-[0_4px_12px_rgba(50,143,151,.35),0_1px_0_rgba(255,255,255,.4)_inset] ${s.chip}`}
			>
				<GavelGlyph size={s.glyph} />
			</span>
			<div className="leading-[1.05]">
				<div
					className={`font-display font-semibold tracking-[-0.01em] ${s.wordmark}`}
				>
					GavelUp
				</div>
				{subtitle ? (
					<div className="mt-0.5 truncate text-[11px] font-semibold tracking-[0.04em] text-[var(--sea-ink-soft)] uppercase">
						{subtitle}
					</div>
				) : null}
			</div>
		</div>
	);
}
