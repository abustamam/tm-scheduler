// The "Guest invites" section of club settings (#1547): the club's own wording
// for the four guest invite drafts the VP Membership page offers, one tab per
// draft, with a live preview of exactly what that draft would say.
//
// Officer-only like the page it sits on; the server re-checks
// (`updateGuestInviteTemplates` -> `requireClubRole(…, ["admin"])`). Nothing is
// sent from GavelUp: a human sends every invite.

import { Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";
import type { InviteKind } from "#/lib/guest-invite";
import {
	customTemplateFor,
	DEFAULT_GUEST_INVITE_TEMPLATES,
	exampleGuestInviteValues,
	GUEST_INVITE_LIMITS,
	GUEST_INVITE_VARIABLES,
	type GuestInviteField,
	type GuestInviteTemplates,
	guestInviteTemplatesSchema,
	INVITE_KIND_LABELS,
	INVITE_KINDS,
} from "#/lib/guest-invite-template";
import { buildNudge } from "#/lib/nudge";
import { toEditorText, toStoredText } from "#/lib/promo-template";
import {
	resetGuestInviteTemplate,
	updateGuestInviteTemplates,
} from "#/server/guest-invite-template";
import { TemplateField } from "./template-field";

type Draft = Record<GuestInviteField, string>;
type Drafts = Record<InviteKind, Draft>;

/** Every draft's two fields in EDITOR form (friendly labels): the saved text,
 *  else the default, as the fields hold them. */
function editorDrafts(t: GuestInviteTemplates): Drafts {
	const one = (kind: InviteKind): Draft => ({
		body: toEditorText(
			t[kind]?.body ?? DEFAULT_GUEST_INVITE_TEMPLATES[kind].body,
			GUEST_INVITE_VARIABLES,
		),
		subject: toEditorText(
			t[kind]?.subject ?? DEFAULT_GUEST_INVITE_TEMPLATES[kind].subject,
			GUEST_INVITE_VARIABLES,
		),
	});
	return {
		never: one("never"),
		firstRecent: one("firstRecent"),
		repeatRecent: one("repeatRecent"),
		lapsed: one("lapsed"),
	};
}

/** The fields as they would be stored: canonical keys. */
function storedDrafts(d: Drafts): GuestInviteTemplates {
	const out: GuestInviteTemplates = {};
	for (const kind of INVITE_KINDS) {
		out[kind] = {
			body: toStoredText(d[kind].body, GUEST_INVITE_VARIABLES),
			subject: toStoredText(d[kind].subject, GUEST_INVITE_VARIABLES),
		};
	}
	return out;
}

const sameDraft = (a: Draft, b: Draft) =>
	toStoredText(a.body, GUEST_INVITE_VARIABLES) ===
		toStoredText(b.body, GUEST_INVITE_VARIABLES) &&
	toStoredText(a.subject, GUEST_INVITE_VARIABLES) ===
		toStoredText(b.subject, GUEST_INVITE_VARIABLES);

const FIELD_LABEL: Record<GuestInviteField, string> = {
	body: "Message",
	subject: "Email subject",
};

export function GuestInviteTemplateEditor({
	clubId,
	templates,
	timezone,
	onSaved,
}: {
	clubId: string;
	templates: GuestInviteTemplates;
	/** The club's time zone, for the preview's example dates. */
	timezone: string;
	onSaved: () => void | Promise<void>;
}) {
	const [fields, setFields] = useState(() => editorDrafts(templates));
	// What the fields were last loaded from: "Discard changes" restores it and
	// "changed?" compares against it.
	const [baseline, setBaseline] = useState(() => editorDrafts(templates));
	const [kind, setKind] = useState<InviteKind>("never");
	const [saving, setSaving] = useState(false);
	const now = useMemo(() => new Date(), []);

	const changed = INVITE_KINDS.some((k) => !sameDraft(fields[k], baseline[k]));
	const defaults = useMemo(() => editorDrafts({}), []);
	const setField = (k: InviteKind, f: GuestInviteField) => (v: string) =>
		setFields((prev) => ({ ...prev, [k]: { ...prev[k], [f]: v } }));

	async function onSave(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const parsed = guestInviteTemplatesSchema.safeParse(storedDrafts(fields));
		if (!parsed.success) {
			const path = parsed.error.issues[0]?.path ?? [];
			const [k, f] = path as [InviteKind?, GuestInviteField?];
			toast.error(
				k && f
					? `${INVITE_KIND_LABELS[k]}: the ${FIELD_LABEL[f].toLowerCase()} is too long.`
					: "Check the templates: a field is not valid.",
			);
			return;
		}
		setSaving(true);
		try {
			await updateGuestInviteTemplates({
				data: { clubId, templates: parsed.data },
			});
			// A field saved as its default is stored as unset and reads back as the
			// default, so the loaded snapshot is the fields themselves.
			setBaseline(fields);
			toast.success("Guest invite templates saved.");
			await onSaved();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setSaving(false);
		}
	}

	async function onReset(k: InviteKind) {
		setSaving(true);
		try {
			await resetGuestInviteTemplate({ data: { clubId, kind: k } });
			// This tab only: its fields and its unsaved edits go; other tabs keep
			// whatever is in the form, saved or not.
			setFields((prev) => ({ ...prev, [k]: defaults[k] }));
			setBaseline((prev) => ({ ...prev, [k]: defaults[k] }));
			toast.success(`${INVITE_KIND_LABELS[k]} reset to the default.`);
			await onSaved();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setSaving(false);
		}
	}

	return (
		<section aria-labelledby="guest-invite-heading" className="space-y-4 pt-2">
			<h2
				id="guest-invite-heading"
				className="font-display text-xl font-semibold tracking-[-0.01em]"
			>
				Guest invites
			</h2>
			<p className="text-sm text-muted-foreground">
				The VP Membership page drafts an invite in one of four wordings,
				depending on how recently the guest visited. Write your own for any of
				them. You send each one yourself; nothing is sent from GavelUp. Type @
				or {"{"} in a field to insert a variable. An empty variable leaves
				nothing in its place.
			</p>

			<form onSubmit={onSave} className="space-y-4">
				<Tabs value={kind} onValueChange={(v) => setKind(v as InviteKind)}>
					<TabsList
						aria-label="Guest invite drafts"
						className="grid w-full grid-cols-2 group-data-[orientation=horizontal]/tabs:h-auto md:grid-cols-4"
					>
						{INVITE_KINDS.map((k) => (
							<TabsTrigger key={k} value={k} className="h-11 md:h-9">
								{INVITE_KIND_LABELS[k]}
							</TabsTrigger>
						))}
					</TabsList>
					{INVITE_KINDS.map((k) => (
						<TabsContent key={k} value={k} className="pt-2">
							<InviteTab
								kind={k}
								draft={fields[k]}
								onChange={setField}
								now={now}
								timezone={timezone}
								defaults={defaults[k]}
								saving={saving}
								onReset={() => onReset(k)}
							/>
						</TabsContent>
					))}
				</Tabs>

				<div className="flex flex-wrap gap-2">
					<Button type="submit" disabled={saving} className="min-w-48 flex-1">
						{saving ? (
							<Loader2 className="size-4 animate-spin" />
						) : (
							"Save guest invites"
						)}
					</Button>
					{changed ? (
						<Button
							type="button"
							variant="ghost"
							onClick={() => setFields(baseline)}
							disabled={saving}
						>
							Discard changes
						</Button>
					) : null}
				</div>
			</form>
		</section>
	);
}

function InviteTab({
	kind,
	draft,
	onChange,
	now,
	timezone,
	defaults,
	saving,
	onReset,
}: {
	kind: InviteKind;
	draft: Draft;
	onChange: (k: InviteKind, f: GuestInviteField) => (v: string) => void;
	now: Date;
	timezone: string;
	defaults: Draft;
	saving: boolean;
	onReset: () => void;
}) {
	const values = useMemo(
		() => exampleGuestInviteValues(kind, now, timezone),
		[kind, now, timezone],
	);
	// Exactly the input the real draft gets: a field still at its default
	// (`customTemplateFor` is null) goes through the built-in builder, an edited
	// one through the template, so the preview cannot disagree with the draft.
	const stored = {
		[kind]: {
			body: toStoredText(draft.body, GUEST_INVITE_VARIABLES),
			subject: toStoredText(draft.subject, GUEST_INVITE_VARIABLES),
		},
	};
	const message = buildNudge({
		mode: "invite",
		inviteKind: kind,
		name: "Alex Example",
		clubName: values.club,
		meetingDate: values.date,
		meetingTime: values.time,
		location: values.location,
		shareUrl: values.agendaLink,
		email: "alex@example.com",
		custom: {
			body: customTemplateFor(stored, kind, "body"),
			subject: customTemplateFor(stored, kind, "subject"),
			values,
		},
	});
	const subject = decodeURIComponent(
		new URL(message.mailtoUrl ?? "mailto:?subject=").searchParams.get(
			"subject",
		) ?? "",
	);

	return (
		<div className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
			<div className="space-y-4">
				<TemplateField
					id={`guest-invite-${kind}-body`}
					label={FIELD_LABEL.body}
					rows={6}
					value={draft.body}
					onChange={onChange(kind, "body")}
					limit={GUEST_INVITE_LIMITS.body}
					defaultValue={defaults.body}
					values={values}
					variables={GUEST_INVITE_VARIABLES}
				/>
				<TemplateField
					id={`guest-invite-${kind}-subject`}
					label={FIELD_LABEL.subject}
					multiline={false}
					value={draft.subject}
					onChange={onChange(kind, "subject")}
					limit={GUEST_INVITE_LIMITS.subject}
					defaultValue={defaults.subject}
					values={values}
					variables={GUEST_INVITE_VARIABLES}
				/>
				<Button
					type="button"
					variant="outline"
					onClick={onReset}
					disabled={saving}
				>
					Reset to default
				</Button>
			</div>
			<aside
				aria-label="Preview"
				data-testid="guest-invite-preview"
				className="min-w-0 space-y-3 self-start rounded-md border border-border bg-card p-3"
			>
				<p className="text-xs font-semibold text-muted-foreground">
					Preview, with an example guest and meeting
				</p>
				<div className="space-y-1">
					<p className="text-xs font-semibold">Message</p>
					<p
						data-testid="guest-invite-preview-message"
						className="text-sm break-words whitespace-pre-wrap"
					>
						{message.message}
					</p>
				</div>
				<div className="space-y-1">
					<p className="text-xs font-semibold">Email subject</p>
					<p
						data-testid="guest-invite-preview-subject"
						className="text-sm break-words"
					>
						{subject}
					</p>
				</div>
			</aside>
		</div>
	);
}
