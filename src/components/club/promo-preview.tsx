// The live preview beside the promo template editor (#1537): what the unsaved
// draft turns into for one meeting, per channel, with the per-channel include
// toggles next to the output they govern and every dropped line shown in place
// with the reason it was dropped.
//
// A Read surface inside an Operate page: read-only (no textareas, no copy, no
// share, no mail; that is the Promote sheet). It composes no channel itself: it
// renders the library's blocks, the same ones the blast strings derive from, so
// the preview and the copied draft cannot disagree. Every line is a text node;
// no HTML string is ever injected.

import { type ReactNode, useEffect, useRef, useState } from "react";
import { FlyerSquareThumb } from "#/components/agenda/flyer-square-export";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Skeleton } from "#/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";
import {
	buildEmailBlocks,
	buildFlyerBlocks,
	buildFlyerContent,
	buildWhatsAppBlast,
	buildWhatsAppBlocks,
	type FlyerMeeting,
	PROMO_CHANNELS,
	PROMO_LIMITS,
	PROMO_PARTS,
	type PromoBlock,
	type PromoChannel,
	type PromoClub,
	type PromoLine,
	type PromoPart,
	type PromoPlaceholder,
	type PromoTemplate,
	promoValues,
	promoVariable,
	toEditorText,
} from "#/lib/promo-template";

export const CHANNEL_LABEL: Record<PromoChannel, string> = {
	whatsapp: "WhatsApp",
	email: "Email",
	flyer: "Flyer",
};

export const PART_LABEL: Record<PromoPart, string> = {
	intro: "Intro",
	whyJoin: "Why join",
	callToAction: "Call to action",
};

/** The widest the flyer thumbnail draws, and its width before the first measurement. */
const FLYER_THUMB_MAX = 320;

/** The email draft's bullet marker (the library's, as it appears on kept lines). */
const EMAIL_BULLET = "- ";

const LINK_KEYS: readonly PromoPlaceholder[] = [
	"meetingLink",
	"rsvpLink",
	"agendaLink",
	"clubLink",
];

/** Why a line was dropped. Names `droppedBy` only: the first empty placeholder
 *  on the line in text order. */
function dropReason(
	key: PromoPlaceholder,
	channel: PromoChannel,
	origin: string,
): string {
	if (key === "joinLink" && channel === "flyer") {
		return "hidden: never printed on the flyer";
	}
	if (key === "online") return "hidden: this meeting is not marked online";
	if (LINK_KEYS.includes(key) && !origin) {
		return "hidden: the link is not known yet";
	}
	return `hidden: no ${promoVariable(key).label} set for this meeting`;
}

function DroppedLine({
	line,
	channel,
	origin,
	as: Tag = "div",
}: {
	line: PromoLine;
	channel: PromoChannel;
	origin: string;
	as?: "div" | "li" | "span";
}) {
	if (line.droppedBy === null) return null;
	return (
		<Tag data-dropped={line.droppedBy}>
			<s className="text-muted-foreground">{toEditorText(line.source)}</s>{" "}
			<span className="text-xs text-muted-foreground">
				{dropReason(line.droppedBy, channel, origin)}
			</span>
		</Tag>
	);
}

/** The lines a block shows: dropped lines in place, kept lines with the same
 *  blank-run collapse the blast applies (no leading, repeated or trailing blank). */
function visibleLines(lines: readonly PromoLine[]): PromoLine[] {
	const out: PromoLine[] = [];
	let seenText = false;
	let lastBlank = false;
	for (const l of lines) {
		if (l.droppedBy !== null) {
			out.push(l);
			continue;
		}
		const blank = !l.text.trim();
		if (blank && (!seenText || lastBlank)) continue;
		if (!blank) seenText = true;
		lastBlank = blank;
		out.push(l);
	}
	// Trailing blanks go: nothing kept follows them.
	let lastText = -1;
	out.forEach((l, i) => {
		if (l.droppedBy === null && l.text.trim()) lastText = i;
	});
	return out.filter((l, i) => l.droppedBy !== null || i <= lastText);
}

function KeptLine({
	text,
	bold = false,
}: {
	text: string;
	bold?: boolean;
}): ReactNode {
	return (
		<div data-kept className={text ? undefined : "h-4"}>
			{bold && text ? <strong>{text}</strong> : text}
		</div>
	);
}

function TextBlock({
	block,
	channel,
	origin,
}: {
	block: PromoBlock;
	channel: PromoChannel;
	origin: string;
}) {
	const lines = visibleLines(block.lines);
	if (lines.length === 0) return null;
	return (
		<div data-block={block.kind} className="space-y-0.5">
			{lines.map((l, i) =>
				l.droppedBy !== null ? (
					<DroppedLine
						// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional and have no id
						key={i}
						line={l}
						channel={channel}
						origin={origin}
					/>
				) : (
					<KeptLine
						// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional and have no id
						key={i}
						text={l.text}
						bold={block.kind === "headline"}
					/>
				),
			)}
		</div>
	);
}

/** An email block: the why-join bullets as a `<ul>`, everything else as lines. */
function EmailBlock({ block, origin }: { block: PromoBlock; origin: string }) {
	if (block.kind !== "whyJoin") {
		return <TextBlock block={block} channel="email" origin={origin} />;
	}
	const lines = visibleLines(block.lines);
	const isItem = (l: PromoLine) =>
		l.droppedBy !== null || l.text.startsWith(EMAIL_BULLET);
	const groups: { list: boolean; lines: PromoLine[] }[] = [];
	for (const l of lines) {
		const list = isItem(l);
		const last = groups[groups.length - 1];
		if (last && last.list === list) last.lines.push(l);
		else groups.push({ list, lines: [l] });
	}
	return (
		<div data-block="whyJoin" className="space-y-1">
			{groups.map((g, gi) =>
				g.list ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: groups are positional
					<ul key={gi} className="list-disc space-y-0.5 pl-5">
						{g.lines.map((l, i) =>
							l.droppedBy !== null ? (
								<DroppedLine
									// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional and have no id
									key={i}
									line={l}
									channel="email"
									origin={origin}
									as="li"
								/>
							) : (
								// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional and have no id
								<li key={i} data-kept>
									{l.text.slice(EMAIL_BULLET.length)}
								</li>
							),
						)}
					</ul>
				) : (
					g.lines.map((l, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional and have no id
						<KeptLine key={`${gi}-${i}`} text={l.text} />
					))
				),
			)}
		</div>
	);
}

function IncludeRow({
	channel,
	channels,
	onChange,
}: {
	channel: PromoChannel;
	channels: PromoTemplate["channels"];
	onChange: (channels: PromoTemplate["channels"]) => void;
}) {
	return (
		<fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
			<legend className="sr-only">
				What the {CHANNEL_LABEL[channel]} version includes
			</legend>
			<span aria-hidden className="font-semibold">
				Include:
			</span>
			{PROMO_PARTS.map((part) => (
				<span key={part} className="inline-flex items-center gap-1.5">
					<input
						type="checkbox"
						aria-label={`${PART_LABEL[part]} in ${CHANNEL_LABEL[channel]}`}
						checked={channels[channel][part]}
						onChange={(e) =>
							onChange({
								...channels,
								[channel]: { ...channels[channel], [part]: e.target.checked },
							})
						}
					/>
					<span aria-hidden>{PART_LABEL[part]}</span>
				</span>
			))}
		</fieldset>
	);
}

/** The flyer thumbnail at `min(container width, 320px)`. */
function FlyerThumb({
	content,
	clubName,
	logoSrc,
}: {
	content: ReturnType<typeof buildFlyerContent>;
	clubName: string;
	logoSrc: string | null;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(FLYER_THUMB_MAX);
	useEffect(() => {
		const el = ref.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const measure = () => {
			const w = el.getBoundingClientRect().width;
			if (w > 0) setWidth(Math.min(w, FLYER_THUMB_MAX));
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	return (
		<div ref={ref} className="w-full">
			<FlyerSquareThumb
				content={content}
				clubName={clubName}
				logoSrc={logoSrc}
				width={width}
			/>
		</div>
	);
}

function Output({
	template,
	club,
	meeting,
	origin,
	logoUrl,
	channel,
}: {
	template: PromoTemplate;
	club: PromoClub;
	meeting: FlyerMeeting;
	origin: string;
	logoUrl: string | null;
	channel: PromoChannel;
}) {
	const values = promoValues(club, meeting, origin);
	if (channel === "whatsapp") {
		const count = buildWhatsAppBlast(template, values).length;
		const long = count > PROMO_LIMITS.whatsappSoft;
		return (
			<div className="space-y-2">
				<div
					data-channel-output="whatsapp"
					className="space-y-2 rounded-xl bg-muted p-3 text-sm whitespace-pre-wrap"
				>
					{buildWhatsAppBlocks(template, values).map((b, i) => (
						<TextBlock
							// biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional
							key={i}
							block={b}
							channel="whatsapp"
							origin={origin}
						/>
					))}
				</div>
				<p
					className={
						long
							? "text-xs text-warning-foreground"
							: "text-xs text-muted-foreground"
					}
				>
					{count} characters
					{long
						? ` — long for a group chat (aim for ${PROMO_LIMITS.whatsappSoft})`
						: ""}
				</p>
			</div>
		);
	}
	if (channel === "email") {
		const { subject, blocks } = buildEmailBlocks(template, values);
		const shown = visibleLines(subject);
		return (
			<div data-channel-output="email" className="space-y-3 text-sm">
				<p>
					<span className="font-semibold">Subject:</span>{" "}
					{shown.map((l, i) =>
						l.droppedBy !== null ? (
							<DroppedLine
								// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional and have no id
								key={i}
								line={l}
								channel="email"
								origin={origin}
								as="span"
							/>
						) : (
							// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional and have no id
							<span key={i} data-subject>
								{l.text}{" "}
							</span>
						),
					)}
				</p>
				{blocks.map((b, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional
					<EmailBlock key={i} block={b} origin={origin} />
				))}
			</div>
		);
	}
	const dropped = buildFlyerBlocks(template, values)
		.flatMap((b) => b.lines)
		.filter((l) => l.droppedBy !== null);
	return (
		<div data-channel-output="flyer" className="space-y-3 text-sm">
			<FlyerThumb
				content={buildFlyerContent(template, values)}
				clubName={club.name}
				logoSrc={logoUrl}
			/>
			{dropped.length > 0 ? (
				<div className="space-y-0.5">
					<p className="font-semibold">Lines left off the flyer</p>
					{dropped.map((l, i) => (
						<DroppedLine
							// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional and have no id
							key={i}
							line={l}
							channel="flyer"
							origin={origin}
						/>
					))}
				</div>
			) : null}
		</div>
	);
}

export function PromoPreview({
	template,
	status,
	club,
	meeting,
	isExample,
	origin,
	logoUrl,
	onChannelsChange,
	onRetry,
}: {
	/** The STORED-form draft. */
	template: PromoTemplate;
	status: "loading" | "error" | "ready";
	/** Null until the context resolves. */
	club: PromoClub | null;
	/** Null until the context resolves. */
	meeting: FlyerMeeting | null;
	isExample: boolean;
	origin: string;
	logoUrl: string | null;
	onChannelsChange: (channels: PromoTemplate["channels"]) => void;
	onRetry: () => void;
}) {
	const ready = status === "ready" && club !== null && meeting !== null;
	return (
		<section aria-label="Preview" className="space-y-3">
			<div className="space-y-1">
				<h3 className="text-xl font-semibold">Preview</h3>
				<p className="text-sm text-muted-foreground">
					Preview of your unsaved changes
				</p>
				{isExample ? (
					<div className="space-y-1">
						<Badge variant="secondary">Example meeting</Badge>
						<p className="text-sm text-muted-foreground">
							No meeting is scheduled yet, so this shows an example.
						</p>
					</div>
				) : null}
			</div>
			<Tabs defaultValue="whatsapp">
				<TabsList>
					{PROMO_CHANNELS.map((c) => (
						<TabsTrigger key={c} value={c}>
							{CHANNEL_LABEL[c]}
						</TabsTrigger>
					))}
				</TabsList>
				{PROMO_CHANNELS.map((c) => (
					<TabsContent
						key={c}
						value={c}
						// Kept mounted so every toggle stays in the DOM; Radix sets no
						// `hidden` on a force-mounted panel, so the inactive ones hide here.
						forceMount
						className="space-y-3 data-[state=inactive]:hidden"
					>
						<IncludeRow
							channel={c}
							channels={template.channels}
							onChange={onChannelsChange}
						/>
						{ready ? (
							<Output
								template={template}
								club={club}
								meeting={meeting}
								origin={origin}
								logoUrl={logoUrl}
								channel={c}
							/>
						) : status === "error" ? (
							<div className="space-y-1">
								<p className="text-sm">
									Couldn't load a meeting for the preview.
								</p>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={onRetry}
								>
									Try again
								</Button>
							</div>
						) : (
							<Skeleton className="h-32 w-full rounded-xl" />
						)}
					</TabsContent>
				))}
			</Tabs>
		</section>
	);
}
