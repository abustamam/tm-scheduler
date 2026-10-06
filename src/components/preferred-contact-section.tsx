import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircle } from "lucide-react";
import {
	CONTACT_METHOD_LABELS,
	type ContactMethod,
	parseContactMethod,
} from "#/lib/preferred-contact";
import {
	getMyContactPreference,
	setMyPreferredContact,
} from "#/server/contact-preference";

const QUERY_KEY = ["my-contact-preference"] as const;

/**
 * "How should officers reach you?" on Account settings (#1093).
 *
 * Lists only the methods the member's own email and phone support, plus "No
 * preference". The server refuses anything else on its own; this list is a
 * courtesy, not the gate. A member with neither on file sees "No preference"
 * alone and a line saying an officer can add their phone — members do not edit
 * their own phone here (out of scope for #1093).
 *
 * Renders nothing for an account with no club member behind it.
 */
export function PreferredContactSection() {
	const queryClient = useQueryClient();
	const state = useQuery({
		queryKey: QUERY_KEY,
		queryFn: () => getMyContactPreference(),
	});
	const save = useMutation({
		mutationFn: (preferredContact: ContactMethod | null) =>
			setMyPreferredContact({ data: { preferredContact } }),
		onSettled: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
	});

	if (!state.data?.linked) return null;
	const { available } = state.data;
	const current = save.isPending
		? (save.variables ?? null)
		: state.data.preferredContact;
	const options: { value: string; label: string }[] = [
		...available.map((m) => ({ value: m, label: CONTACT_METHOD_LABELS[m] })),
		{ value: "", label: "No preference" },
	];

	return (
		<div className="space-y-3 rounded-xl border bg-card p-4">
			<div className="min-w-0">
				<h2 className="flex items-center gap-2 font-medium">
					<MessageCircle className="size-4 text-primary" aria-hidden />
					How should officers reach you?
				</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					Your clubs' officers see this beside your name.
				</p>
			</div>
			<fieldset className="space-y-1.5" disabled={save.isPending}>
				<legend className="sr-only">Preferred contact method</legend>
				{options.map((o) => (
					<label key={o.value} className="flex items-center gap-2 text-sm">
						<input
							type="radio"
							name="preferredContact"
							value={o.value}
							checked={(current ?? "") === o.value}
							onChange={() => save.mutate(parseContactMethod(o.value))}
							className="size-4"
						/>
						{o.label}
					</label>
				))}
			</fieldset>
			{available.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					There is no phone number or email on file for you. An officer can add
					your phone number to the club roster.
				</p>
			) : null}
			{save.error ? (
				<p role="alert" className="text-sm text-destructive">
					{save.error instanceof Error
						? save.error.message
						: "Couldn't save your preference."}
				</p>
			) : null}
		</div>
	);
}
