import { useState } from "react";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "#/components/ui/command";
import { goesBy, isBlankQuery, searchPeople } from "#/lib/person-search";

export interface PickerPerson {
	kind: "member" | "guest";
	id: string;
	name: string;
	preferredName?: string | null;
	/** Guests only. "lost" rows are hidden until the query is non-blank. */
	stage?: string;
	/** Caller order, lower first (e.g. pickerTier). Default 0. */
	rank?: number;
}

/**
 * The one member/guest picker (#1332, part of #1320): an inline list, no popover
 * or sheet; callers wrap it. Filtering and order come from `searchPeople`, so
 * every picker finds a person by preferred name the same way. Rows the caller
 * hides must already be removed from `people`. The query lives here: callers
 * reset it by keying the component.
 */
export function PersonPicker<T extends PickerPerson>({
	people,
	onPick,
	placeholder,
	emptyText,
	disabled = false,
	renderMeta,
	renderLeading,
	renderSubline,
	nameClassName,
	autoFocus,
}: {
	people: readonly T[];
	onPick: (person: T) => void;
	placeholder: string;
	emptyText: string;
	disabled?: boolean;
	renderMeta?: (person: T) => React.ReactNode;
	renderLeading?: (person: T) => React.ReactNode;
	/** Line under the name (e.g. "Last: …"). */
	renderSubline?: (person: T) => React.ReactNode;
	/** Class for the name text only, e.g. to recede an unavailable member. */
	nameClassName?: (person: T) => string | undefined;
	autoFocus?: boolean;
}) {
	const [query, setQuery] = useState("");
	const blank = isBlankQuery(query);
	const visible = people.filter(
		(p) => !(p.kind === "guest" && p.stage === "lost" && blank),
	);
	const matched = searchPeople(query, visible, { rank: (p) => p.rank ?? 0 });
	const members = matched.filter((p) => p.kind === "member");
	const guests = matched.filter((p) => p.kind === "guest");
	const hasBothKinds =
		people.some((p) => p.kind === "member") &&
		people.some((p) => p.kind === "guest");

	function group(heading: string, rows: T[]) {
		if (rows.length === 0) return null;
		return (
			<CommandGroup heading={hasBothKinds ? heading : undefined}>
				{rows.map((p) => {
					const alias = goesBy(p);
					return (
						<CommandItem
							key={`${p.kind}:${p.id}`}
							value={`${p.kind}:${p.id}`}
							disabled={disabled}
							onSelect={() => onPick(p)}
							className="flex items-center justify-between gap-2"
						>
							<span className="flex items-center gap-2">
								{renderLeading?.(p)}
								<span className="flex flex-col">
									<span className={nameClassName?.(p)}>
										{p.name}
										{alias ? (
											<span className="text-muted-foreground">
												{" "}
												· goes by {alias}
											</span>
										) : null}
									</span>
									{renderSubline?.(p)}
								</span>
							</span>
							{renderMeta?.(p)}
						</CommandItem>
					);
				})}
			</CommandGroup>
		);
	}

	return (
		<Command shouldFilter={false}>
			<CommandInput
				placeholder={placeholder}
				value={query}
				onValueChange={setQuery}
				autoFocus={autoFocus}
			/>
			<CommandList>
				<CommandEmpty>{emptyText}</CommandEmpty>
				{group("Members", members)}
				{group("Guests", guests)}
			</CommandList>
		</Command>
	);
}
