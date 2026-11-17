/**
 * One confetti burst for the awards reveal (#1654, D5). `canvas-confetti` is
 * loaded with a dynamic import on first use, so it is not in the deck's initial
 * bundle and never touches the server render. Reduced motion is honoured by the
 * library itself (`disableForReducedMotion`). A failed chunk load is swallowed:
 * the confetti is decoration and must never break the slide.
 */
export async function fireAwardConfetti(): Promise<void> {
	if (typeof window === "undefined") return;
	try {
		const { default: confetti } = await import("canvas-confetti");
		await confetti({
			particleCount: 140,
			spread: 80,
			origin: { y: 0.6 },
			disableForReducedMotion: true,
		});
	} catch {
		// Decoration only.
	}
}
