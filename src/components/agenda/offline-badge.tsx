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
 * Floats top-center to clear the Present `.pptx` button and Print toolbar (both
 * top-right); always `no-print` so it never lands on a printed sheet.
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
			<div className="no-print" style={wrap}>
				<span style={pill}>
					<span style={dot} />
					Available offline
				</span>
			</div>
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

const wrap: React.CSSProperties = {
	position: "fixed",
	top: 8,
	left: "50%",
	transform: "translateX(-50%)",
	zIndex: 30,
	pointerEvents: "none",
};

const pill: React.CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: 6,
	padding: "3px 10px",
	borderRadius: 999,
	fontSize: 12,
	fontWeight: 600,
	color: "#3f6212",
	background: "rgba(240, 253, 244, 0.92)",
	border: "1px solid rgba(101, 163, 13, 0.35)",
};

const dot: React.CSSProperties = {
	width: 7,
	height: 7,
	borderRadius: 999,
	background: "#65a30d",
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
