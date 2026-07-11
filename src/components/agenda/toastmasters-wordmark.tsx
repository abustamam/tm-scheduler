import type { CSSProperties } from "react";
import colorMark from "#/assets/ToastmastersWordmarkColorTight.png";
import whiteMark from "#/assets/ToastmastersWordmarkWhiteTight.png";

/** The official Toastmasters International wordmark. `tone="color"` for light
 *  grounds (navy/maroon), `tone="white"` for the navy footer + Thank-You. */
export function ToastmastersWordmark({
	tone,
	className,
	style,
}: {
	tone: "color" | "white";
	className?: string;
	style?: CSSProperties;
}) {
	return (
		<img
			src={tone === "color" ? colorMark : whiteMark}
			alt="Toastmasters International"
			className={className}
			style={style}
		/>
	);
}
