import { useId } from "react";

/**
 * Circular SVG progress ring with a lagoon→lagoon-deep gradient arc over a
 * `--sand` track, with centered content (e.g. "62%" / "LEVEL 3").
 */
export function ProgressRing({
	pct,
	value,
	label,
	size = 128,
	stroke = 12,
}: {
	/** Fill fraction, 0–100. */
	pct: number;
	/** Big centered value (defaults to `{pct}%`). */
	value?: string;
	/** Small centered caption under the value. */
	label?: string;
	size?: number;
	stroke?: number;
}) {
	const gradientId = useId();
	const center = size / 2;
	const radius = center - stroke / 2 - 2;
	const circ = 2 * Math.PI * radius;
	const offset = circ * (1 - pct / 100);

	return (
		<div className="relative shrink-0" style={{ width: size, height: size }}>
			<svg
				width={size}
				height={size}
				viewBox={`0 0 ${size} ${size}`}
				role="img"
				aria-label={`${value ?? `${pct}%`} complete`}
			>
				<title>{`${value ?? `${pct}%`} complete`}</title>
				<circle
					cx={center}
					cy={center}
					r={radius}
					fill="none"
					stroke="var(--sand)"
					strokeWidth={stroke}
				/>
				<circle
					cx={center}
					cy={center}
					r={radius}
					fill="none"
					stroke={`url(#${gradientId})`}
					strokeWidth={stroke}
					strokeLinecap="round"
					strokeDasharray={circ}
					strokeDashoffset={offset}
					transform={`rotate(-90 ${center} ${center})`}
				/>
				<defs>
					<linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
						<stop offset="0" stopColor="var(--lagoon)" />
						<stop offset="1" stopColor="var(--lagoon-deep)" />
					</linearGradient>
				</defs>
			</svg>
			<div className="absolute inset-0 flex flex-col items-center justify-center">
				<span className="font-display text-[30px] leading-none font-semibold">
					{value ?? `${pct}%`}
				</span>
				{label ? (
					<span className="mt-0.5 text-[11px] font-bold tracking-[0.05em] text-[var(--sea-ink-soft)]">
						{label}
					</span>
				) : null}
			</div>
		</div>
	);
}
