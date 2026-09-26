// The "Promote meetings" section of club settings (#931): the club's ONE
// blast template, and a way to draft a promo for the next meeting.
//
// Admin-only, like the page it sits on; the server re-checks
// (`updatePromoTemplate` → `requireClubRole(…, ["admin"])`).

import { Loader2, Megaphone } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import {
	DEFAULT_PROMO_TEMPLATE,
	PROMO_CHANNELS,
	PROMO_LIMITS,
	PROMO_PARTS,
	PROMO_PLACEHOLDERS,
	type PromoChannel,
	type PromoPart,
	type PromoTemplate,
	promoTemplateSchema,
	templateWarnings,
} from "#/lib/promo-template";
import { resetPromoTemplate, updatePromoTemplate } from "#/server/promo";

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

export function PromoTemplateEditor({
	clubId,
	template,
	onSaved,
}: {
	clubId: string;
	template: PromoTemplate;
	onSaved: () => void | Promise<void>;
}) {
	const [headline, setHeadline] = useState(template.headline);
	const [intro, setIntro] = useState(template.intro);
	const [bullets, setBullets] = useState(template.whyJoin.join("\n"));
	const [cta, setCta] = useState(template.callToAction);
	const [channels, setChannels] = useState(template.channels);
	const [saving, setSaving] = useState(false);
	const [promoteOpen, setPromoteOpen] = useState(false);

	const draft: PromoTemplate = {
		headline,
		intro,
		whyJoin: bulletsFromText(bullets),
		callToAction: cta,
		channels,
	};
	const warnings = templateWarnings(draft);

	function load(t: PromoTemplate) {
		setHeadline(t.headline);
		setIntro(t.intro);
		setBullets(t.whyJoin.join("\n"));
		setCta(t.callToAction);
		setChannels(t.channels);
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
				Placeholders:{" "}
				{PROMO_PLACEHOLDERS.map((p) => (
					<code key={p} className="mr-1 text-xs">{`{${p}}`}</code>
				))}
				— a line whose placeholder is empty is left out.
			</p>

			<form onSubmit={onSave} className="space-y-4">
				<div className="space-y-2">
					<Label htmlFor="promo-headline">Headline</Label>
					<Input
						id="promo-headline"
						value={headline}
						maxLength={PROMO_LIMITS.headline}
						onChange={(e) => setHeadline(e.target.value)}
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="promo-intro">Intro</Label>
					<Textarea
						id="promo-intro"
						rows={7}
						value={intro}
						maxLength={PROMO_LIMITS.intro}
						onChange={(e) => setIntro(e.target.value)}
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="promo-why">Why join (one per line)</Label>
					<Textarea
						id="promo-why"
						rows={5}
						value={bullets}
						onChange={(e) => setBullets(e.target.value)}
					/>
					<p className="text-xs text-muted-foreground">
						Up to {PROMO_LIMITS.bullets}.
					</p>
				</div>
				<div className="space-y-2">
					<Label htmlFor="promo-cta">Call to action</Label>
					<Input
						id="promo-cta"
						value={cta}
						maxLength={PROMO_LIMITS.callToAction}
						onChange={(e) => setCta(e.target.value)}
					/>
				</div>

				<fieldset className="space-y-2">
					<legend className="text-sm font-medium">
						What each version includes
					</legend>
					<table className="text-sm">
						<thead>
							<tr>
								<th />
								{PROMO_CHANNELS.map((c) => (
									<th key={c} className="px-3 font-medium">
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

				{warnings.length > 0 ? (
					<p
						role="alert"
						className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-sm"
					>
						Not a placeholder: {warnings.map((w) => `{${w}}`).join(", ")}. It
						will show exactly as typed.
					</p>
				) : null}

				<div className="flex gap-2">
					<Button type="submit" disabled={saving} className="flex-1">
						{saving ? (
							<Loader2 className="size-4 animate-spin" />
						) : (
							"Save promo template"
						)}
					</Button>
					<Button
						type="button"
						variant="outline"
						onClick={onReset}
						disabled={saving}
					>
						Reset to default
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
