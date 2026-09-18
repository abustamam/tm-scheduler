import { WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { useOfflineReady, useOnlineStatus } from "#/hooks/use-online-status";
import { offlineVisitKey, relativeTime } from "#/lib/offline-status";

/**
 * Passive offline indicator for the read-only Present / Print views (#174).
 *
 * Online + cached → a quiet "Available offline" pill (trust, no action needed).
 * Offline → a banner naming how stale the cached agenda is.
 *
 * The pill is deliberately recessive (#726) — see `PILL_INK` below for why it
 * still carries a ground of its own, and what that costs in contrast.
 *
 * The two states are positioned differently on purpose (#361). The online pill
 * used to float `position: fixed` top-center, which put a passive reassurance
 * message on top of the one thing we want people to read; it now renders inline
 * so the host places it in its own chrome (the Print toolbar row, the Present
 * top-right cluster). The offline banner is the opposite case — it is news the
 * reader needs — so it stays pinned top-center and prominent no matter where
 * the component is mounted. Both are `no-print` so neither lands on a sheet.
 *
 * Mounting note: because the banner is `position: fixed`, its DOM parent is
 * irrelevant to where it paints — but a positioned ancestor (`z-index`) does
 * form the stacking context it competes in, which is why both hosts mount this
 * inside chrome that already paints above the page content.
 */
export function OfflineBadge({ id }: { id: string }) {
	const online = useOnlineStatus();
	const offlineReady = useOfflineReady();
	const [cachedAt, setCachedAt] = useState<number | null>(null);

	// Stamp "last loaded while online" on every online render; read it back when
	// offline so the banner can say how old the cached copy is.
	useEffect(() => {
		if (typeof localStorage === "undefined") return;
		const key = offlineVisitKey(id);
		if (online) {
			const now = Date.now();
			try {
				localStorage.setItem(key, String(now));
			} catch {
				// Private mode / storage disabled — indicator degrades silently.
			}
			setCachedAt(now);
		} else {
			try {
				const raw = localStorage.getItem(key);
				setCachedAt(raw ? Number(raw) : null);
			} catch {
				setCachedAt(null);
			}
		}
	}, [id, online]);

	if (online) {
		if (!offlineReady) return null;
		return (
			<span className="no-print" style={pill}>
				<span style={dot} />
				Available offline
			</span>
		);
	}

	const label = cachedAt ? relativeTime(cachedAt, Date.now()) : null;
	return (
		<div className="no-print" style={wrap}>
			<span style={banner}>
				<WifiOff size={14} aria-hidden />
				{label
					? `Offline · showing the agenda as of ${label}`
					: "Offline · showing the last saved agenda"}
			</span>
		</div>
	);
}

/** Only the offline banner pins itself; the online pill flows with its host. */
const wrap: React.CSSProperties = {
	position: "fixed",
	top: 8,
	left: "50%",
	transform: "translateX(-50%)",
	zIndex: 30,
	pointerEvents: "none",
};

/**
 * The pill's ink and ground (#726). Neutral slate rather than the saturated
 * green this shipped with, no border, 11px at weight 500, and a 5px dot — the
 * pill is pure reassurance that is on screen for a whole meeting, including on
 * a projected wall, so it should be findable if you look for it and ignorable
 * if you are not.
 *
 * The ground is WHITE at 0.85, not "no background", and that is the one value
 * here that is not taste. The component takes no host prop, so a single style
 * has to stay legible on every ground it is mounted over, and those run the
 * full range: the Print toolbar's `#fff` (`print-theme.tsx`'s
 * `PRINT_TOOLBAR_STYLE`), the Present view's `bg-black` letterbox bars, the
 * content slide's off-white `GROUND` (`#f3f4f4`) and the dark splash's navy
 * (`#0a4f78`) — see `meeting-present.tsx:35-42`. Bare ink cannot serve both
 * ends of that range, so the chip carries just enough ground of its own.
 *
 * What that buys, measured as WCAG contrast of `PILL_INK` over `PILL_GROUND`
 * composited on each of those four: 7.58 (toolbar) / 5.36 (black bar) / 7.47
 * (content slide) / 5.90 (navy splash). The floor is the black bar at 5.36:1,
 * against AA's 4.5:1 for normal text — and against the 5.65:1 the loud green
 * pill had on the same ground, so this is quieter WITHOUT being harder to
 * read. `offline-badge.test.tsx` recomputes all four rather than trusting this
 * comment; jsdom loads no stylesheet and can see nothing about legibility on
 * its own.
 *
 * Nice property of pure white as the ground: on the white Print toolbar the
 * chip composites to the toolbar's own colour, so it reads as bare text there
 * and only grows a visible plate where the ground is dark enough to need one.
 */
const PILL_INK = "#475569";
const PILL_GROUND = "rgba(255, 255, 255, 0.85)";

const pill: React.CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: 5,
	padding: "2px 8px",
	borderRadius: 999,
	fontSize: 11,
	fontWeight: 500,
	color: PILL_INK,
	// `backgroundColor`, not the `background` shorthand: the test reads this
	// value back off the rendered node to recompute the ratios above, and
	// jsdom's shorthand expansion is not something to stake that on.
	backgroundColor: PILL_GROUND,
};

const dot: React.CSSProperties = {
	width: 5,
	height: 5,
	borderRadius: 999,
	backgroundColor: "#94a3b8",
};

const banner: React.CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: 6,
	padding: "5px 12px",
	borderRadius: 999,
	fontSize: 13,
	fontWeight: 600,
	color: "#7c2d12",
	background: "rgba(255, 247, 237, 0.96)",
	border: "1px solid rgba(234, 88, 12, 0.4)",
	boxShadow: "0 4px 14px rgba(124, 45, 18, 0.15)",
};
