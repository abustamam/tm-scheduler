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
	PROMO_CHANNELS,
	PROMO_LIMITS,
	PROMO_PARTS,
	type PromoChannel,
	type PromoPart,
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
import { TemplateField } from "./template-field";

const PromoteSheet = lazy(() =>
	import("./promote-sheet").then((m) => ({ default: m.PromoteSheet })),
);

const CHANNEL_LABEL: Record<PromoChannel, string> = {
	whatsapp: "WhatsApp",
	email: "Email",
	flyer: "Flyer",
};

const PART_LABEL: Record<PromoPart, string> = {
	intro: "Intro",
	whyJoin: "Why join",
	callToAction: "Call to action",
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

	// The menu's value column: the selected meeting, else the example one.
	const selectedMeeting = context
		? context.meetings.find((m) => m.id === context.selectedId)
		: undefined;
	const values = context
		? promoValues(
				context.club,
				selectedMeeting ??
					examplePromoMeeting(new Date(), context.club.timezone),
				window.location.origin,
			)
		: null;

	const draft = draftFrom(fields, channels);
	const changed = !templatesEqual(
		draft,
		draftFrom(editorFields(baseline), baseline.channels),
	);
	const defaults = editorFields(DEFAULT_PROMO_TEMPLATE);
	const setField = (k: keyof EditorFields) => (v: string) =>
		setFields((prev) => ({ ...prev, [k]: v }));

	// The club's context, once per mount: the menu's value column reads it, and
	// the preview (next issue) will too. A failure leaves the fields editable.
	useEffect(() => {
		let cancelled = false;
		getPromoContext({ data: { clubId } })
			.then((ctx) => {
				if (!cancelled) setContext(ctx);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [clubId]);

	function load(t: PromoTemplate) {
		setFields(editorFields(t));
		setChannels(t.channels);
		setBaseline(t);
	}

	async function onSave(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const parsed = promoTemplateSchema.safeParse(draft);
		if (!parsed.success) {
			toast.error(
				`Check the template: ${parsed.error.issues[0]?.path.join(".") || "a field"} is not valid.`,
			);
			return;
		}
		setSaving(true);
		try {
			await updatePromoTemplate({ data: { clubId, template: parsed.data } });
			// The schema trims; loading the normalised snapshot is what makes
			// "Discard changes" absent right after Save.
			load(parsed.data);
			toast.success("Promo template saved.");
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
			toast.success("Promo template reset to the default.");
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
				Type @ or {"{"} in any field to insert a variable, or use Insert
				variable. A line whose variable is empty for a meeting is left out.
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

			<form onSubmit={onSave} className="space-y-4">
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
					label="Why join (one per line)"
					rows={5}
					value={fields.bullets}
					onChange={setField("bullets")}
					bullets={{ perLine: PROMO_LIMITS.bullet, max: PROMO_LIMITS.bullets }}
					defaultValue={defaults.bullets}
					values={values}
				/>
				<TemplateField
					id="promo-cta"
					label="Call to action"
					multiline={false}
					value={fields.cta}
					onChange={setField("cta")}
					limit={PROMO_LIMITS.callToAction}
					defaultValue={defaults.cta}
					values={values}
				/>

				<fieldset className="space-y-2">
					<legend className="text-sm font-semibold">
						What each version includes
					</legend>
					<table className="text-sm">
						<thead>
							<tr>
								<th />
								{PROMO_CHANNELS.map((c) => (
									<th key={c} className="px-3 font-semibold">
										{CHANNEL_LABEL[c]}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{PROMO_PARTS.map((part) => (
								<tr key={part}>
									<td className="pr-3">{PART_LABEL[part]}</td>
									{PROMO_CHANNELS.map((c) => (
										<td key={c} className="px-3 text-center">
											<input
												type="checkbox"
												aria-label={`${PART_LABEL[part]} in ${CHANNEL_LABEL[c]}`}
												checked={channels[c][part]}
												onChange={(e) =>
													setChannels((prev) => ({
														...prev,
														[c]: { ...prev[c], [part]: e.target.checked },
													}))
												}
											/>
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</fieldset>

				<div className="flex gap-2">
					<Button type="submit" disabled={saving} className="flex-1">
						{saving ? (
							<Loader2 className="size-4 animate-spin" />
						) : (
							"Save promo template"
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
						Reset to default (follows future updates)
					</Button>
				</div>
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
