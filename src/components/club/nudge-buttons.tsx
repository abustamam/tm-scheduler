import { Mail, MessageCircle, MessageSquareText, Phone } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import type { LevelProgress } from "#/lib/level-proximity";
import { buildNudge } from "#/lib/nudge";
import type { OrientationTick } from "#/lib/orientation-roster";
import { detectPlatform } from "#/lib/platform";
import {
	type ContactMethod,
	isIos,
	smsHref,
	telHref,
} from "#/lib/preferred-contact";
import type { RoleDuty } from "#/lib/role-duties";

interface NudgeButtonsBase {
	name: string;
	/** What to call them in the draft, when it isn't the first token of `name`
	 *  (#486). Absent/null falls back to that first token. */
	preferredName?: string | null;
	phone: string | null;
	email: string | null;
	/** The member's EFFECTIVE preferred method (`effectivePreferredContact`,
	 *  #1093), never the raw column. Its button leads and is marked; Call and SMS
	 *  render only when preferred. Absent/null keeps the two classic buttons. */
	preferredContact?: ContactMethod | null;
	/** Fired when the Call, SMS, WhatsApp or Email draft link is tapped (auto-mark contacted). */
	onContacted?: () => void;
	/** Render glyphs with no text label. OPT-IN, because this component is shared
	 *  with the agenda slot cards and the recruit picker, where the words are
	 *  affordable; only the 340px attendance rail needs the space back. */
	iconOnly?: boolean;
}

/** The meeting a draft asks about. Required on every arm but `orientation`. */
interface NudgeButtonsMeeting {
	meetingDate: string;
	shareUrl: string;
}

/** Discriminated on `mode`, mirroring `NudgeInput` — a single shape with an
 *  optional `roleName` would let a `confirm`/`recruit` caller omit the field
 *  that mode's message interpolates, and draft "you're our undefined". */
export type NudgeButtonsProps = NudgeButtonsBase &
	(
		| {
				/** A new member partway through orientation (#942): the draft names
				 *  their next open checklist item. Role-less; `items` is the
				 *  checklist as #940 derives it, `origin` builds the guide link.
				 *  The ONE arm whose meeting is optional: the path, Base Camp and
				 *  mentor drafts need none (`orientationNudgeAvailable`). */
				mode: "orientation";
				items: readonly OrientationTick[];
				origin: string;
				meetingDate?: string | null;
				shareUrl?: string | null;
		  }
		| (NudgeButtonsMeeting & NudgeButtonsMeetingArm)
	);

type NudgeButtonsMeetingArm =
	| { mode: "attendance" | "arriving" }
	| {
			/** A guest invite to the next meeting (#899). Role-less, and never
			 *  carries a personal link or a `join_url`. */
			mode: "invite";
			clubName: string;
			meetingTime: string;
			location?: string | null;
	  }
	| ({
			/** A member close to a Pathways level (#900): "want to get it on
			 *  the agenda?" Role-less; `shareUrl` is the next meeting's page. */
			mode: "level";
	  } & LevelProgress)
	| {
			mode: "confirm" | "recruit";
			roleName: string;
			/** What the role still owes (#667), ALREADY filtered by the
			 *  registry's `done` — the caller passes `outstandingDuties(...)`.
			 *  On the role arm only, mirroring `NudgeInput`: a role-less draft
			 *  has no duty to name. */
			duties?: readonly RoleDuty[];
			/** The recipient's own meeting page, from `personalNudgeUrl`.
			 *  Absent (a guest holder has no member identity) falls the draft
			 *  back to `shareUrl`. */
			personalUrl?: string | null;
			/** The role's card on the public roles guide, from `rolesGuideUrl`
			 *  (#933) — a GUEST holder's `confirm` link in place of the bare
			 *  agenda. Ignored by `recruit`; `personalUrl` wins when set. */
			guideUrl?: string | null;
	  };

/**
 * WhatsApp/Email tap-to-nudge affordances (#37). Renders only the channels the
 * target has; a muted "No contact on file" when neither. Links open the VPE's
 * own app pre-drafted — the human edits and sends. The app never sends.
 */
export function NudgeButtons(props: NudgeButtonsProps) {
	const {
		name,
		preferredName,
		phone,
		email,
		onContacted,
		iconOnly = false,
		preferredContact = null,
	} = props;
	// Render the channel links only after mount. The caller builds `shareUrl` with
	// a `window.location.origin` prefix that is correct only on the client; during
	// SSR it falls back to a RELATIVE path, so an anchor tapped before hydration
	// would carry a broken link in the draft message. Gating on mount keeps the
	// links off the server render entirely (#37). The no-contact state needs no
	// URL, so it still renders on the server.
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);

	// Detection is deferred to the post-mount render; the server pass falls back
	// to "mobile", the historical `wa.me` behavior (#485).
	//
	// NOT because `navigator` is missing on the server — it is not. Node 21+ ships
	// a global one, so on `node:22-slim` `detectPlatform(navigator)` returns
	// "desktop" (UA `Node.js/24`) rather than throwing. That is the actual hazard:
	// unguarded, the server would emit `web.whatsapp.com` while a phone's first
	// client render emits `wa.me`, and the two disagree on an attribute React has
	// to reconcile — a hydration MISMATCH, not a crash. The guard makes the server
	// pass and every first client render agree.
	//
	// This comment claimed the opposite until `WhatsAppPhoneLink` was written and
	// the claim was checked. Left uncorrected it invites the obvious cleanup:
	// verify `navigator` exists, delete the "unnecessary" guard, ship the
	// mismatch.
	const platform = mounted ? detectPlatform(navigator) : "mobile";
	// iOS needs its own `sms:` body separator; WhatsApp treats it as mobile.
	const ios = mounted && isIos(navigator);

	// Branch on the discriminant so `roleName` is carried only where it exists.
	// Spreading `props` wholesale would defeat the union: TS cannot narrow a
	// spread, and the field would go back to being optional at the boundary the
	// union exists to hold.
	const common = {
		name,
		preferredName,
		phone,
		email,
		platform,
	};
	// The meeting rides each arm's own branch rather than `common`, because it is
	// optional on `orientation` alone and `common` is shared by every arm.
	// Branch on the ROLE-BEARING modes, not on the role-less ones: `attendance` and
	// `arriving` both carry no `roleName`, so testing for one of them by name left
	// the other falling into the branch that reads `props.roleName` — which does not
	// exist on it.
	const nudge = buildNudge(
		props.mode === "confirm" || props.mode === "recruit"
			? {
					...common,
					meetingDate: props.meetingDate,
					shareUrl: props.shareUrl,
					mode: props.mode,
					roleName: props.roleName,
					// Carried on the SAME branch as `roleName`, for the same reason:
					// these three fields exist together on the role arm and a spread of
					// `props` would put the duty clause back in reach of a draft that
					// names no role.
					duties: props.duties,
					personalUrl: props.personalUrl,
					guideUrl: props.guideUrl,
				}
			: props.mode === "invite"
				? {
						...common,
						meetingDate: props.meetingDate,
						shareUrl: props.shareUrl,
						mode: props.mode,
						clubName: props.clubName,
						meetingTime: props.meetingTime,
						location: props.location,
					}
				: props.mode === "level"
					? {
							...common,
							meetingDate: props.meetingDate,
							shareUrl: props.shareUrl,
							mode: props.mode,
							pathName: props.pathName,
							level: props.level,
							projectsLeft: props.projectsLeft,
							projectNames: props.projectNames,
							electivesToChoose: props.electivesToChoose,
						}
					: props.mode === "orientation"
						? {
								...common,
								meetingDate: props.meetingDate,
								shareUrl: props.shareUrl,
								mode: props.mode,
								items: props.items,
								origin: props.origin,
							}
						: {
								...common,
								meetingDate: props.meetingDate,
								shareUrl: props.shareUrl,
								mode: props.mode,
							},
	);

	const callUrl = preferredContact === "call" ? telHref(phone) : null;
	const smsUrl =
		preferredContact === "sms"
			? smsHref(phone, ios ? "ios" : platform, nudge.message)
			: null;

	if (!nudge.whatsappUrl && !nudge.mailtoUrl && !callUrl && !smsUrl) {
		return (
			<span className="text-xs text-[var(--sea-ink-soft)]">
				No contact on file
			</span>
		);
	}

	if (!mounted) return null;

	// `name`, not `preferredName`: the rail row this label is announced
	// against displays the full `name`, so the accessible label matches what
	// the officer sees on screen.
	//
	// Both links announce that they leave the page, matching `WhatsAppPhoneLink`
	// (#37) — a screen reader gives no other signal that `target="_blank"` is
	// about to happen. `WhatsAppPhoneLink` composes that phrase from an
	// `sr-only` span rather than an `aria-label`, because it still has visible
	// content (the phone number) whose accessible name a label would override;
	// it has no `aria-label` at all. Icon-only mode here has no visible content
	// left, so it uses `aria-label` instead — the two names are NOT identical
	// strings (`+1555… — message Jane on WhatsApp, opens in a new tab` there vs.
	// `Message Jane on WhatsApp, opens in a new tab` here), only the
	// "opens in a new tab" convention is shared. `title` reuses the longer
	// `waLabel` here, because icon-only mode has no visible text left for a
	// sighted mouse user to read — the tooltip is doing work the sibling
	// doesn't need it to do (`WhatsAppPhoneLink`'s `title` is a deliberately
	// SHORT, separate string, `Message ${name} on WhatsApp`, no "opens in a new
	// tab", pinned by five test files). Do not "harmonise" the two by
	// lengthening `WhatsAppPhoneLink`'s title to match:
	// `members.$id.test.tsx:233` asserts `queryByTitle(/on WhatsApp$/)).toBeNull()`
	// with an ANCHORED matcher, so appending this suffix there would make that
	// assertion pass because the anchor stopped matching the (now longer)
	// title, not because the title is actually gone.
	// `mailto:` does not open a tab, so `mailLabel` says nothing about it.
	const marked = (m: ContactMethod, label: string) =>
		preferredContact === m ? `${label} (preferred)` : label;
	const waLabel = marked(
		"whatsapp",
		`Message ${name} on WhatsApp, opens in a new tab`,
	);
	const mailLabel = marked("email", `Email ${name}`);
	const callLabel = marked("call", `Call ${name}`);
	const smsLabel = marked("sms", `Text ${name} by SMS`);

	const badge = (m: ContactMethod) =>
		preferredContact === m && !iconOnly ? (
			<span className="rounded-full bg-[rgba(79,184,178,.16)] px-1.5 text-[10px] font-bold text-[var(--lagoon-deep)]">
				Preferred
			</span>
		) : null;

	const link = (
		m: ContactMethod,
		href: string,
		label: string,
		text: string,
		icon: ReactNode,
		external: boolean,
	) => (
		<Button
			key={m}
			asChild
			size={iconOnly ? "icon-sm" : "sm"}
			variant="outline"
		>
			<a
				href={href}
				{...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
				onClick={onContacted}
				aria-label={iconOnly ? label : undefined}
				title={iconOnly ? label : undefined}
			>
				{icon}
				{iconOnly ? null : text}
				{badge(m)}
			</a>
		</Button>
	);

	const buttons: Partial<Record<ContactMethod, ReactNode>> = {
		call: callUrl
			? link(
					"call",
					callUrl,
					callLabel,
					"Call",
					<Phone className="size-4" aria-hidden />,
					false,
				)
			: null,
		sms: smsUrl
			? link(
					"sms",
					smsUrl,
					smsLabel,
					"SMS",
					<MessageSquareText className="size-4" aria-hidden />,
					false,
				)
			: null,
		whatsapp: nudge.whatsappUrl
			? link(
					"whatsapp",
					nudge.whatsappUrl,
					waLabel,
					"WhatsApp",
					<MessageCircle className="size-4" aria-hidden />,
					true,
				)
			: null,
		email: nudge.mailtoUrl
			? link(
					"email",
					nudge.mailtoUrl,
					mailLabel,
					"Email",
					<Mail className="size-4" aria-hidden />,
					false,
				)
			: null,
	};
	// Preferred first (Call/SMS only exist when preferred), then today's order.
	const order: ContactMethod[] = ["call", "sms", "whatsapp", "email"];
	if (preferredContact) {
		order.splice(order.indexOf(preferredContact), 1);
		order.unshift(preferredContact);
	}

	return (
		<div className={`flex items-center ${iconOnly ? "gap-0.5" : "gap-1.5"}`}>
			{order.map((m) => buttons[m] ?? null)}
		</div>
	);
}
