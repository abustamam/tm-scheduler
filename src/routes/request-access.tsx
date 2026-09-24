import { createFileRoute } from "@tanstack/react-router";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MarketingShell } from "#/components/marketing/marketing-shell";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import { CONTACT_MAILTO, PILOT_PRICING_LINE } from "#/lib/brand";
import { readRef } from "#/lib/marketing-ref";
import {
	type SubmitAccessRequestResult,
	submitAccessRequest,
} from "#/server/access-requests";
import {
	ACCESS_REQUEST_KINDS,
	ACCESS_REQUEST_BOUNDS as B,
	ACCESS_REQUEST_HONEYPOT_FIELD as HONEYPOT_FIELD,
	type AccessRequestKind as Kind,
} from "#/server/access-requests-schemas";

const KIND_LABELS: Record<Kind, string> = {
	club: "A club",
	district: "A district",
};

const TITLE = "Request access — GavelUp";
const DESCRIPTION =
	"GavelUp is invite-only while it's young. Tell us about your club or district and we'll set it up ourselves.";

/**
 * The request-access form (#866), replacing the `mailto:` every "Request
 * access" button used to be. Public, and deliberately NOT redirecting a
 * signed-in visitor: someone signed in with no club is exactly a prospect.
 */
export const Route = createFileRoute("/request-access")({
	// Returned RAW with no default: a validated search that differs from the
	// parsed one makes the router 307 (CLAUDE.md), so the component, not this,
	// decides what an absent or unknown `kind` means.
	validateSearch: (search: Record<string, unknown>): { kind?: unknown } => ({
		kind: search.kind as unknown,
	}),
	head: () => ({
		meta: [
			{ title: TITLE },
			{ name: "description", content: DESCRIPTION },
			{ property: "og:title", content: TITLE },
			{ property: "og:description", content: DESCRIPTION },
		],
	}),
	component: RequestAccess,
});

const kindOf = (raw: unknown): Kind =>
	raw === "district" ? "district" : "club";

type Outcome = "sent" | "alreadyReceived" | "busy";

function outcomeOf(res: SubmitAccessRequestResult): Outcome {
	if (!res.ok) return "busy";
	return res.alreadyReceived ? "alreadyReceived" : "sent";
}

function RequestAccess() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const [kind, setKind] = useState<Kind>(kindOf(search.kind));
	// Back/forward changes the URL without a toggle click.
	useEffect(() => setKind(kindOf(search.kind)), [search.kind]);

	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [clubName, setClubName] = useState("");
	const [clubNumber, setClubNumber] = useState("");
	const [districtNumber, setDistrictNumber] = useState("");
	const [message, setMessage] = useState("");
	const [trap, setTrap] = useState("");

	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [outcome, setOutcome] = useState<Outcome | null>(null);

	// When the form opened, on the CLIENT's monotonic clock, for the server's
	// too-fast bot filter. The server gets only the elapsed `fillMs`, so no
	// client clock is ever compared with the server's. Null until hydration:
	// the submit button is disabled until then (which also blocks implicit
	// Enter-key submission), and a submit that somehow lands first sends
	// `fillMs: 0`, which the server treats as too fast rather than waving it on.
	const openedAt = useRef<number | null>(null);
	const [ready, setReady] = useState(false);
	useEffect(() => {
		openedAt.current = performance.now();
		setReady(true);
	}, []);

	function chooseKind(next: Kind) {
		setKind(next);
		void navigate({
			to: "/request-access",
			search: { kind: next },
			replace: true,
		});
	}

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (pending) return;
		const fillMs =
			openedAt.current === null ? 0 : performance.now() - openedAt.current;
		setPending(true);
		setError(null);
		try {
			const res = await submitAccessRequest({
				data: {
					kind,
					name,
					email,
					...(kind === "club" ? { clubName, clubNumber } : { districtNumber }),
					message,
					ref: readRef(),
					trap,
					fillMs,
				},
			});
			setOutcome(outcomeOf(res));
		} catch {
			setError(
				"Something went wrong. Check the fields above and try again, or email us.",
			);
		} finally {
			setPending(false);
		}
	}

	return (
		<MarketingShell>
			<main className="mx-auto w-full max-w-xl flex-1 px-5 py-12 sm:px-8">
				<p className="font-extrabold text-[11.5px] text-[var(--palm)] uppercase tracking-[0.12em]">
					Invite-only while it's young
				</p>
				<h1 className="mt-3 font-display font-semibold text-3xl tracking-[-0.02em]">
					Request access
				</h1>
				<p className="mt-3 text-sm font-semibold text-[var(--sea-ink)]">
					{PILOT_PRICING_LINE}
				</p>

				{outcome ? (
					<OutcomePanel outcome={outcome} />
				) : (
					// `method="post"`: if the browser ever submits this natively (no JS
					// yet), the fields must not land in a GET query string.
					<form
						method="post"
						onSubmit={handleSubmit}
						className="mt-8 space-y-6"
					>
						<div
							role="tablist"
							aria-label="Who is asking"
							className="inline-flex rounded-full border border-[var(--line)] bg-[var(--surface)] p-1"
						>
							{ACCESS_REQUEST_KINDS.map((value) => (
								<button
									key={value}
									type="button"
									role="tab"
									aria-selected={kind === value}
									onClick={() => chooseKind(value)}
									className={
										kind === value
											? "rounded-full bg-[var(--sea-ink)] px-4 py-1.5 font-semibold text-sm text-[var(--surface)]"
											: "rounded-full px-4 py-1.5 font-semibold text-sm text-[var(--sea-ink-soft)]"
									}
								>
									{KIND_LABELS[value]}
								</button>
							))}
						</div>

						<div className="space-y-4 rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] p-5">
							<Field id="ra-name" label="Your name">
								<Input
									id="ra-name"
									value={name}
									onChange={(e) => setName(e.target.value)}
									autoComplete="name"
									maxLength={B.nameMax}
									required
								/>
							</Field>
							<Field id="ra-email" label="Email">
								<Input
									id="ra-email"
									type="email"
									value={email}
									onChange={(e) => setEmail(e.target.value)}
									autoComplete="email"
									maxLength={B.emailMax}
									required
								/>
							</Field>

							{kind === "club" ? (
								<>
									<Field id="ra-club-name" label="Club name">
										<Input
											id="ra-club-name"
											value={clubName}
											onChange={(e) => setClubName(e.target.value)}
											autoComplete="organization"
											maxLength={B.clubNameMax}
											required
										/>
									</Field>
									<Field
										id="ra-club-number"
										label="Club number"
										optional
										hint="Found on your club's TI page."
									>
										<Input
											id="ra-club-number"
											value={clubNumber}
											onChange={(e) => setClubNumber(e.target.value)}
											inputMode="numeric"
											pattern={B.clubNumberPattern}
											maxLength={B.clubNumberMax}
										/>
									</Field>
									<Field id="ra-message" label="Anything else" optional>
										<Textarea
											id="ra-message"
											value={message}
											onChange={(e) => setMessage(e.target.value)}
											maxLength={B.messageMax}
										/>
									</Field>
								</>
							) : (
								<>
									<Field id="ra-district" label="District number">
										<Input
											id="ra-district"
											value={districtNumber}
											onChange={(e) => setDistrictNumber(e.target.value)}
											pattern={B.districtNumberPattern}
											maxLength={B.districtNumberMax}
											required
										/>
									</Field>
									<Field
										id="ra-message"
										label="What are you hoping for?"
										optional
									>
										<Textarea
											id="ra-message"
											value={message}
											onChange={(e) => setMessage(e.target.value)}
											maxLength={B.messageMax}
										/>
									</Field>
								</>
							)}

							{/* Honeypot. Invisible and unreachable for a person (off-screen,
							    out of the tab order, hidden from assistive tech); a bot
							    filling every field fills this one too, and the server
							    answers it with a silent success. */}
							<div className="sr-only" aria-hidden="true">
								<label htmlFor={HONEYPOT_FIELD}>Leave this empty</label>
								<input
									id={HONEYPOT_FIELD}
									name={HONEYPOT_FIELD}
									type="text"
									tabIndex={-1}
									autoComplete="off"
									data-1p-ignore
									data-lpignore="true"
									value={trap}
									onChange={(e) => setTrap(e.target.value)}
								/>
							</div>
						</div>

						{error ? (
							<p role="alert" className="text-sm text-destructive">
								{error}
							</p>
						) : null}

						<Button type="submit" size="lg" disabled={!ready || pending}>
							{pending ? (
								<Loader2 className="size-4 animate-spin" aria-hidden />
							) : null}
							Send request
						</Button>
					</form>
				)}
			</main>
		</MarketingShell>
	);
}

function Field({
	id,
	label,
	optional = false,
	hint,
	children,
}: {
	id: string;
	label: string;
	optional?: boolean;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="space-y-2">
			<Label htmlFor={id}>
				{label}
				{optional ? (
					<span className="font-normal text-muted-foreground">(optional)</span>
				) : null}
			</Label>
			{children}
			{hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
		</div>
	);
}

function OutcomePanel({ outcome }: { outcome: Outcome }) {
	return (
		<div
			aria-live="polite"
			className="mt-8 flex flex-col items-start gap-3 rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] p-6"
		>
			{outcome === "busy" ? (
				<p className="text-sm leading-relaxed">
					We're getting a lot of requests right now. Try again tomorrow, or{" "}
					<a href={CONTACT_MAILTO} className="font-semibold underline">
						email us
					</a>
					.
				</p>
			) : (
				<>
					<CheckCircle2 className="size-8 text-success" aria-hidden />
					<p className="text-sm leading-relaxed">
						{outcome === "alreadyReceived"
							? "We already have your request. We'll be in touch soon."
							: "Thanks! We'll be in touch within a few days."}
					</p>
				</>
			)}
		</div>
	);
}
