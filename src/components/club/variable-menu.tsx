// The variable menu of `TemplateField` (#1536): a listbox in a popover whose
// focus never leaves the textarea (the field drives it through
// `aria-activedescendant`). Rows show the meeting's value, so this file renders
// meeting values and is on the #731 sweep list.

import {
	BookOpen,
	Braces,
	Calendar,
	CalendarCheck,
	CalendarClock,
	CalendarPlus,
	ClipboardList,
	Clock,
	ExternalLink,
	Globe,
	Hash,
	Link,
	type LucideIcon,
	MapPin,
	Sparkles,
	StickyNote,
	User,
	Users,
	Video,
} from "lucide-react";
import { useEffect, useRef } from "react";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "#/components/ui/popover";
import {
	type PromoPlaceholder,
	TEMPLATE_GROUP_LABELS,
	type TemplateVariable,
} from "#/lib/promo-template";
import { cn } from "#/lib/utils";

/** Typed on the Promote key union: a new Promote placeholder without an icon fails
 *  typecheck. The guest invite's own keys follow; any other key falls back to
 *  `FALLBACK_ICON`. */
export const VARIABLE_ICONS: Record<
	PromoPlaceholder | GuestOnlyKey,
	LucideIcon
> = {
	date: Calendar,
	time: Clock,
	location: MapPin,
	theme: Sparkles,
	wordOfTheDay: BookOpen,
	meetingNumber: Hash,
	meetingLink: Link,
	rsvpLink: CalendarCheck,
	agendaLink: ClipboardList,
	clubLink: Globe,
	joinLink: ExternalLink,
	club: Users,
	note: StickyNote,
	online: Video,
	guestName: User,
	firstVisit: CalendarPlus,
	lastVisit: CalendarClock,
	visitCount: Hash,
};

const FALLBACK_ICON: LucideIcon = Braces;

function iconFor(key: string): LucideIcon {
	return (
		(VARIABLE_ICONS as Record<string, LucideIcon | undefined>)[key] ??
		FALLBACK_ICON
	);
}

/** An option row is 44px below `md`, 36px from `md` up. */
export const OPTION_ROW_HEIGHT = "h-11 md:h-9";

/** The variable whose description is a warning, not just a gloss. */
const WARNING_DESCRIPTION = "joinLink";

/** Keys only the guest invite registry has; kept here so their icons are typed. */
type GuestOnlyKey = "guestName" | "firstVisit" | "lastVisit" | "visitCount";

/** The groups the listed options fall in, in order of first appearance, each
 *  with its heading. Promote's table is grouped meeting, links, club, extras, so
 *  this yields exactly the order the menu always had. */
function groupsOf(
	options: readonly TemplateVariable[],
): { id: string; label: string }[] {
	const out: { id: string; label: string }[] = [];
	for (const v of options)
		if (!out.some((g) => g.id === v.group))
			out.push({
				id: v.group,
				label: TEMPLATE_GROUP_LABELS[v.group] ?? v.group,
			});
	return out;
}

export function VariableMenu({
	open,
	onDismiss,
	listboxId,
	options,
	activeKey,
	onPick,
	values,
	children,
}: {
	open: boolean;
	onDismiss: () => void;
	listboxId: string;
	/** The variables to list, already filtered, in table order. */
	options: readonly TemplateVariable[];
	activeKey: string | null;
	onPick: (key: string) => void;
	values: Readonly<Record<string, string>> | null;
	/** The field wrapper the popover anchors to. */
	children: React.ReactNode;
}) {
	const activeRef = useRef<HTMLLIElement | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the active key is the trigger
	useEffect(() => {
		activeRef.current?.scrollIntoView?.({ block: "nearest" });
	}, [activeKey]);

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				if (!next) onDismiss();
			}}
		>
			<PopoverAnchor asChild>{children}</PopoverAnchor>
			<PopoverContent
				side="bottom"
				align="start"
				className="w-(--radix-popover-trigger-width) max-w-md p-1"
				onOpenAutoFocus={(e) => e.preventDefault()}
				onCloseAutoFocus={(e) => e.preventDefault()}
				// The textarea owns the pointer; a click on it must not dismiss.
				onInteractOutside={(e) => e.preventDefault()}
			>
				<ul
					// biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the listbox the textarea's aria-activedescendant names (#1536)
					role="listbox"
					id={listboxId}
					aria-label="Variables"
					className="max-h-72 overflow-y-auto"
				>
					{groupsOf(options).map((group) => {
						const rows = options.filter((v) => v.group === group.id);
						if (rows.length === 0) return null;
						return (
							<li key={group.id} role="presentation">
								{/* biome-ignore lint/a11y/useSemanticElements: a group inside a listbox, not a form fieldset (#1536) */}
								<ul role="group" aria-label={group.label}>
									<li
										role="presentation"
										aria-hidden
										className="px-2 pt-2 pb-1 text-xs font-semibold text-muted-foreground"
									>
										{group.label}
									</li>
									{rows.map((v) => {
										const Icon = iconFor(v.key);
										const active = v.key === activeKey;
										const value = values?.[v.key];
										return (
											// biome-ignore lint/a11y/useFocusableInteractive: focus stays in the textarea, which names the active option (#1536)
											// biome-ignore lint/a11y/useKeyWithClickEvents: the textarea owns the keyboard (#1536)
											<li
												key={v.key}
												ref={active ? activeRef : undefined}
												// biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: an option of that listbox (#1536)
												role="option"
												id={`${listboxId}-${v.key}`}
												aria-selected={active}
												className={cn(
													"flex cursor-pointer items-center gap-2 rounded-sm px-2 text-sm",
													OPTION_ROW_HEIGHT,
													active && "bg-accent text-accent-foreground",
												)}
												onMouseDown={(e) => e.preventDefault()}
												onClick={() => onPick(v.key)}
											>
												<Icon className="size-4 shrink-0" aria-hidden />
												<span className="min-w-0 flex-1">
													<span className="block truncate">{v.label}</span>
													<span
														title={v.description}
														className={cn(
															"block truncate text-xs",
															v.key === WARNING_DESCRIPTION
																? "text-warning-foreground"
																: "text-muted-foreground",
														)}
													>
														{v.description}
													</span>
												</span>
												{value === undefined ? null : value === "" ? (
													<span className="shrink-0 text-xs text-muted-foreground">
														not set
													</span>
												) : (
													<span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">
														{value}
													</span>
												)}
											</li>
										);
									})}
								</ul>
							</li>
						);
					})}
				</ul>
			</PopoverContent>
		</Popover>
	);
}
