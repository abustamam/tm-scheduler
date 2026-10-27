import { avatarGradient, type MemberTone } from "#/data/club";
import { cn } from "#/lib/utils";

/**
 * Circular gradient avatar with member initials. The gradient is chosen by the
 * member's "tone" (see {@link avatarGradient}). Size is the pixel diameter.
 */
export function MemberAvatar({
	tone,
	initials,
	size = 38,
	className,
}: {
	tone: MemberTone;
	initials: string;
	size?: number;
	className?: string;
}) {
	return (
		<span
			aria-hidden
			className={cn(
				"flex shrink-0 items-center justify-center rounded-full font-bold",
				// The lagoon and amber gradients end on --lagoon-deep and
				// --warning-strong, the two fills styles.css says never to put white
				// on (3.8:1 and 3.2:1 light, worse dark). Palm stays dark in light
				// mode, where white measures 6.4:1.
				tone === "palm" ? "text-white" : "text-on-accent-fill",
				className,
			)}
			style={{
				width: size,
				height: size,
				fontSize: Math.round(size * 0.33),
				background: avatarGradient(tone),
			}}
		>
			{initials}
		</span>
	);
}
