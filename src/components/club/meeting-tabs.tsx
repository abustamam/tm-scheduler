import { type ReactNode, useEffect, useRef, useState } from "react";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "#/components/ui/tabs.tsx";
import type { MeetingTab } from "#/lib/meeting-hub";

/** The visible label of each tab. Exact, per the spec: a test pins them. */
export const MEETING_TAB_LABELS: Record<MeetingTab, string> = {
	roles: "Roles",
	attendance: "Attendance",
	ballots: "Ballots",
	minutes: "Minutes",
};

/** Marks a panel so the fragment handler can ask "which tab owns this element". */
const PANEL_ATTR = "data-meeting-tab-panel";

/**
 * The meeting page's tab shell (#1582): the tab bar and one panel per offered
 * tab. It decides WHERE an already-permitted section renders and nothing else.
 *
 * - Every offered panel stays mounted when inactive (Radix `forceMount` plus a
 *   class that hides `data-state="inactive"`), so unsaved minutes text, an open
 *   disqualify form and the attendance filter survive a tab switch.
 * - With one tab (Roles) no tab bar renders.
 * - The active tab is STATE, initialised from `active` (the URL, read during
 *   SSR) and reconciled to the live URL after mount: the service worker answers
 *   an offline navigation from cache ignoring the query string, so the HTML a
 *   viewer gets can be the one rendered for another `?tab=`.
 * - A fragment naming an element inside a panel (`#slot-<id>`, `#minutes`)
 *   activates that tab and then scrolls to the element, on mount and on
 *   `hashchange`. When the URL carries both, the fragment's tab wins.
 */
export function MeetingTabs({
	tabs,
	active,
	onSelect,
	panels,
}: {
	/** The offered tabs, in order. Always starts with `"roles"`. */
	tabs: MeetingTab[];
	/** The tab the URL names, already resolved against `tabs`. */
	active: MeetingTab;
	onSelect: (tab: MeetingTab) => void;
	/** One panel per offered tab. */
	panels: Partial<Record<MeetingTab, ReactNode>>;
}) {
	const [current, setCurrent] = useState<MeetingTab>(active);
	const rootRef = useRef<HTMLDivElement>(null);
	const pendingScrollId = useRef<string | null>(null);
	const [scrollTick, setScrollTick] = useState(0);
	// The effects below read the freshest offered list without re-subscribing.
	const tabsRef = useRef(tabs);
	tabsRef.current = tabs;
	const activeRef = useRef(active);
	activeRef.current = active;

	// A tab that stopped being offered (a gate flipped) falls back to Roles.
	const shown: MeetingTab = tabs.includes(current) ? current : "roles";

	// The URL moved (back/forward, or a link): follow it.
	useEffect(() => {
		setCurrent(active);
	}, [active]);

	// After mount: make the visible panel match the LIVE URL (`active` is the
	// router's search on the client, so it is the live one). React does not
	// patch attributes on hydration, so when cached HTML was rendered for another
	// tab, state alone would leave the wrong panel showing; the DOM is brought
	// into line directly, once, as well.
	useEffect(() => {
		const live = activeRef.current;
		const root = rootRef.current;
		if (!root) return;
		// `data-state` only: with `forceMount` Radix never sets `hidden`, the
		// hiding is the `data-[state=inactive]:hidden` class, and a `hidden`
		// attribute set here would never be cleared again.
		for (const panel of root.querySelectorAll<HTMLElement>(`[${PANEL_ATTR}]`)) {
			panel.dataset.state =
				panel.getAttribute(PANEL_ATTR) === live ? "active" : "inactive";
		}
		for (const trigger of root.querySelectorAll<HTMLElement>('[role="tab"]')) {
			const isLive = trigger.dataset.tab === live;
			trigger.dataset.state = isLive ? "active" : "inactive";
			trigger.setAttribute("aria-selected", String(isLive));
		}
	}, []);

	// Fragment links into a panel.
	useEffect(() => {
		const follow = () => {
			const raw = window.location.hash.slice(1);
			if (!raw) return;
			let id = raw;
			try {
				id = decodeURIComponent(raw);
			} catch {
				// keep the raw fragment
			}
			const el = document.getElementById(id);
			const panel = el?.closest(`[${PANEL_ATTR}]`);
			const owner = panel?.getAttribute(PANEL_ATTR) as MeetingTab | null;
			if (!owner || !tabsRef.current.includes(owner)) return;
			pendingScrollId.current = id;
			setCurrent(owner);
			setScrollTick((t) => t + 1);
		};
		follow();
		window.addEventListener("hashchange", follow);
		return () => window.removeEventListener("hashchange", follow);
	}, []);

	// Scroll once the owning panel is the visible one.
	// biome-ignore lint/correctness/useExhaustiveDependencies: scrollTick is the trigger
	useEffect(() => {
		const id = pendingScrollId.current;
		if (!id) return;
		pendingScrollId.current = null;
		document.getElementById(id)?.scrollIntoView();
	}, [scrollTick]);

	return (
		<Tabs
			ref={rootRef}
			value={shown}
			onValueChange={(value) => {
				const tab = value as MeetingTab;
				setCurrent(tab);
				onSelect(tab);
			}}
		>
			{tabs.length > 1 ? (
				<TabsList className="w-full" aria-label="Meeting sections">
					{tabs.map((tab) => (
						<TabsTrigger key={tab} value={tab} data-tab={tab}>
							{MEETING_TAB_LABELS[tab]}
						</TabsTrigger>
					))}
				</TabsList>
			) : null}
			{tabs.map((tab) => (
				<TabsContent
					key={tab}
					value={tab}
					forceMount
					{...{ [PANEL_ATTR]: tab }}
					className="min-w-0 space-y-5 data-[state=inactive]:hidden"
				>
					{panels[tab]}
				</TabsContent>
			))}
		</Tabs>
	);
}
