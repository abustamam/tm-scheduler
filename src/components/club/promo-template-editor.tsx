// The "Promote meetings" section of club settings (#931): the club's ONE
// blast template, and a way to draft a promo for the next meeting.
//
// Admin-only, like the page it sits on; the server re-checks
// (`updatePromoTemplate` → `requireClubRole(…, ["admin"])`).

import { Loader2, Megaphone } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import {
	DEFAULT_PROMO_TEMPLATE,
	examplePromoMeeting,
	type FlyerMeeting,
	PROMO_LIMITS,
	type PromoTemplate,
	promoTemplateSchema,
	promoValues,
	templatesEqual,
	toEditorText,
	toStoredText,
} from "#/lib/promo-template";
import {
	getPromoContext,
	type PromoContext,
	resetPromoTemplate,
	updatePromoTemplate,
} from "#/server/promo";
import { PromoMeetingPicker } from "./promo-meeting-picker";
import { PromoPreview } from "./promo-preview";
import { TemplateField } from "./template-field";

const PromoteSheet = lazy(() =>
	import("./promote-sheet").then((m) => ({ default: m.PromoteSheet })),
);

/** Schema key -> the label the user sees, for the save-failure toast. */
const FIELD_LABEL: Record<string, string> = {
	headline: "Headline",
	intro: "Intro",
	whyJoin: "Why join",
	callToAction: "Closing line",
};

/** The bullets as the textarea holds them: one per line, blanks dropped. */
export function bulletsFromText(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
}

/** The four text fields in EDITOR form (friendly labels), as the fields hold them. */
interface EditorFields {
	headline: string;
	intro: string;
	bullets: string;
	cta: string;
}

function editorFields(t: PromoTemplate): EditorFields {
	return {
		headline: toEditorText(t.headline),
		intro: toEditorText(t.intro),
		bullets: toEditorText(t.whyJoin.join("\n")),
		cta: toEditorText(t.callToAction),
	};
}

/** The template the fields currently say, in STORED form. */
function draftFrom(
	f: EditorFields,
	channels: PromoTemplate["channels"],
): PromoTemplate {
	return {
		headline: toStoredText(f.headline),
		intro: toStoredText(f.intro),
		whyJoin: bulletsFromText(toStoredText(f.bullets)),
		callToAction: toStoredText(f.cta),
		channels,
	};
}

export function PromoTemplateEditor({
	clubId,
	template,
	storedInvalid = false,
	onSaved,
}: {
	clubId: string;
	template: PromoTemplate;
	/** The club's stored template no longer parses; `template` is the default
	 *  standing in for it. Said out loud, because saving will replace it. */
	storedInvalid?: boolean;
	onSaved: () => void | Promise<void>;
}) {
	const [fields, setFields] = useState(() => editorFields(template));
	const [channels, setChannels] = useState(template.channels);
	// The stored template the fields were last loaded from: what "Discard
	// changes" restores and what "changed?" compares against. Compared through
	// the same editor round trip as the draft, so a stored `{Date}` (read as the
	// variable) does not open dirty.
	const [baseline, setBaseline] = useState(template);
	const [saving, setSaving] = useState(false);
	const [promoteOpen, setPromoteOpen] = useState(false);
	const [context, setContext] = useState<PromoContext | null>(null);
	const [status, setStatus] = useState<"loading" | "error" | "ready">(
		"loading",
	);
	// Bumped by "Try again": the context effect re-runs on it.
	const [attempt, setAttempt] = useState(0);
	// The meeting the officer picked in the preview; null until they pick one.
	const [pickedId, setPickedId] = useState<string | null>(null);

	// The meeting the menu's values and the preview read: the picked one, else
	// the server's selection, else the first, else an example one.
	const meetings = context?.meetings ?? [];
	const previewMeeting: FlyerMeeting | null = context
		? (meetings.find((m) => m.id === (pickedId ?? context.selectedId)) ??
			meetings[0] ??
			examplePromoMeeting(new Date(), context.club.timezone))
		: null;
	const origin = typeof window === "undefined" ? "" : window.location.origin;
	const values =
		context && previewMeeting
			? promoValues(context.club, previewMeeting, origin)
			: null;

	const draft = draftFrom(fields, channels);
	const changed = !templatesEqual(
		draft,
		draftFrom(editorFields(baseline), baseline.channels),
	);
	const defaults = editorFields(DEFAULT_PROMO_TEMPLATE);
	const setField = (k: keyof EditorFields) => (v: string) =>
		setFields((prev) => ({ ...prev, [k]: v }));

	// The club's context, once per mount (and per "Try again"): the menu's value
	// column and the preview read it. A failure leaves the fields editable.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` only re-triggers the load
	useEffect(() => {
		let cancelled = false;
		setStatus("loading");
		getPromoContext({ data: { clubId } })
			.then((ctx) => {
				if (cancelled) return;
				setContext(ctx);
				setStatus("ready");
			})
			.catch(() => {
				if (!cancelled) setStatus("error");
			});
		return () => {
			cancelled = true;
		};
	}, [clubId, attempt]);

	function load(t: PromoTemplate) {
		setFields(editorFields(t));
		setChannels(t.channels);
		setBaseline(t);
	}

	async function onSave(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const parsed = promoTemplateSchema.safeParse(draft);
		if (!parsed.success) {
			const label = FIELD_LABEL[String(parsed.error.issues[0]?.path[0] ?? "")];
			toast.error(
				label
					? `Check "${label}": it is empty or too long.`
					: "Check the template: a field is empty or too long.",
			);
			return;
		}
		setSaving(true);
		try {
			await updatePromoTemplate({ data: { clubId, template: parsed.data } });
			// The schema trims; loading the normalised snapshot is what makes
			// "Discard changes" absent right after Save.
			load(parsed.data);
			toast.success("Template saved.");
			await onSaved();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setSaving(false);
		}
	}

	async function onReset() {
		setSaving(true);
		try {
			await resetPromoTemplate({ data: clubId });
			load(DEFAULT_PROMO_TEMPLATE);
			toast.success("Back to GavelUp's template.");
			await onSaved();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setSaving(false);
		}
	}

	return (
		<section aria-labelledby="promote-heading" className="space-y-4 pt-2">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h2
					id="promote-heading"
					className="font-display text-xl font-semibold tracking-[-0.01em]"
				>
					Promote meetings
				</h2>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => setPromoteOpen(true)}
				>
					<Megaphone className="size-4" aria-hidden />
					Promote the next meeting
				</Button>
			</div>
			<p className="text-sm text-muted-foreground">
				One template drafts a WhatsApp message, an email and a flyer for any
				meeting. You copy or share them yourself; nothing is sent from GavelUp.
				The highlighted words, like Date and Theme, fill in by themselves for
				each meeting. Type @ to add one. A line with nothing to fill in, such as
				Theme for a meeting without one, is left out.
			</p>

			{storedInvalid ? (
				<p
					role="alert"
					data-testid="promo-template-invalid"
					className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-sm"
				>
					Your club's saved template couldn't be read, so the default is shown
					below and is what drafts use for now. Saving replaces the stored one
					with what you see here.
				</p>
			) : null}

			<form
				onSubmit={onSave}
				className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]"
			>
				<div className="space-y-4">
					<TemplateField
						id="promo-headline"
						label="Headline"
						multiline={false}
						value={fields.headline}
						onChange={setField("headline")}
						limit={PROMO_LIMITS.headline}
						defaultValue={defaults.headline}
						values={values}
					/>
					<TemplateField
						id="promo-intro"
						label="Intro"
						rows={7}
						value={fields.intro}
						onChange={setField("intro")}
						limit={PROMO_LIMITS.intro}
						defaultValue={defaults.intro}
						values={values}
					/>
					<TemplateField
						id="promo-why"
						label="Why join"
						hint="One reason per line."
						rows={5}
						value={fields.bullets}
						onChange={setField("bullets")}
						bullets={{
							perLine: PROMO_LIMITS.bullet,
							max: PROMO_LIMITS.bullets,
						}}
						defaultValue={defaults.bullets}
						values={values}
					/>
					<TemplateField
						id="promo-cta"
						label="Closing line"
						multiline={false}
						value={fields.cta}
						onChange={setField("cta")}
						limit={PROMO_LIMITS.callToAction}
						defaultValue={defaults.cta}
						values={values}
					/>

					<div className="flex flex-wrap gap-2">
						<Button type="submit" disabled={saving} className="min-w-48 flex-1">
							{saving ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								"Save template"
							)}
						</Button>
						{changed ? (
							<Button
								type="button"
								variant="ghost"
								onClick={() => load(baseline)}
								disabled={saving}
							>
								Discard changes
							</Button>
						) : null}
						<Button
							type="button"
							variant="outline"
							onClick={onReset}
							disabled={saving}
						>
							Start over with GavelUp's template
						</Button>
					</div>
					<p className="text-xs text-muted-foreground">
						Starting over also picks up improvements GavelUp makes to its
						template later.
					</p>
				</div>
				<aside className="space-y-3 self-start lg:sticky lg:top-20">
					{meetings.length > 1 && context ? (
						<PromoMeetingPicker
							id="promo-preview-meeting"
							meetings={meetings}
							timezone={context.club.timezone}
							value={previewMeeting?.id ?? ""}
							onChange={setPickedId}
						/>
					) : null}
					<PromoPreview
						template={draft}
						status={status}
						club={context?.club ?? null}
						meeting={previewMeeting}
						isExample={meetings.length === 0}
						origin={origin}
						logoUrl={context?.logoUrl ?? null}
						onChannelsChange={setChannels}
						onRetry={() => setAttempt((n) => n + 1)}
					/>
				</aside>
			</form>

			{promoteOpen ? (
				<Suspense fallback={null}>
					<PromoteSheet
						open={promoteOpen}
						onOpenChange={setPromoteOpen}
						clubId={clubId}
					/>
				</Suspense>
			) : null}
		</section>
	);
}
