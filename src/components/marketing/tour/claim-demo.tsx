import type { ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";

/**
 * Scene 1 of `/tour`: the meeting page's role list on a phone, a facsimile of
 * `MeetingAgenda` (`meeting-agenda.tsx`): the "Roles filled" bar, slot cards
 * with "Open" / "Filled" / "(you)", the success-outline Claim button, Release,
 * the "Who are you?" name picker (`identity-gate.tsx`) the first time, and the
 * claim sheet (`ClaimSheet`) with a speech-title field for a speaker slot.
 *
 * Local state only: nothing is sent and nothing survives a reload. Officer
 * controls (Assign, Remove, Confirm, take over) are left out on purpose.
 *
 * The dialog and the sheet are drawn IN the phone frame rather than through
 * the shadcn `Dialog` / `Sheet`: those portal to <body>, which would put them
 * over the whole page instead of the phone. {@link FrameOverlay} gives the
 * same contract: role="dialog", aria-modal, a labelled title, Escape closes,
 * Tab stays inside, focus goes to the first control and returns on close.
 *
 * Focus: a claim replaces the focused Claim button, so focus moves to that
 * row's Release (and Release moves it back to the row's Claim). A polite live
 * region announces each outcome, and the visible toast is hidden from it so it
 * is not read twice. Bezel hex is the device's own, as in `MemberRoleList`.
 */
type Slot = {
	id: string;
	role: string;
	holder: string | null;
	speaker?: boolean;
	title?: string;
	pathway?: string;
	evaluates?: string;
	min?: number;
	max?: number;
	/** Seeded holder, who stays put; the visitor's claims are not seeded. */
	seeded?: boolean;
};

const INITIAL_SLOTS: readonly Slot[] = [
	{ id: "tm", role: "Toastmaster", holder: "Marcus Lee", seeded: true },
	{
		id: "s1",
		role: "Speaker 1",
		holder: "Daniel Osei",
		speaker: true,
		title: "Small Boats",
		pathway: "Dynamic Leadership",
		min: 5,
		max: 7,
		seeded: true,
	},
	{ id: "s2", role: "Speaker 2", holder: null, speaker: true, min: 5, max: 7 },
	{
		id: "ev",
		role: "Evaluator 1",
		holder: null,
		evaluates: "Speaker 1",
	},
	{ id: "timer", role: "Timer", holder: null },
	{ id: "ah", role: "Ah-Counter", holder: "Ana Ruiz", seeded: true },
];

export const CLAIM_DEMO_NAMES = [
	"Jordan Reyes",
	"Sam Whitfield",
	"Lena Park",
] as const;

type Stage = "idle" | "who" | "sheet";
type FocusTarget = { id: string; kind: "claim" | "release" } | null;

function FrameOverlay({
	title,
	description,
	align,
	onClose,
	children,
}: {
	title: string;
	description?: string;
	align: "center" | "bottom";
	onClose: () => void;
	children: ReactNode;
}) {
	const titleId = useId();
	const descId = useId();
	const panel = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const first = panel.current?.querySelector<HTMLElement>(
			"input, button, [href]",
		);
		first?.focus();
	}, []);

	function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
		if (e.key === "Escape") {
			e.stopPropagation();
			onClose();
			return;
		}
		if (e.key !== "Tab") return;
		const items = panel.current?.querySelectorAll<HTMLElement>(
			"input, button:not([disabled])",
		);
		if (!items || items.length === 0) return;
		const firstEl = items[0];
		const lastEl = items[items.length - 1];
		if (e.shiftKey && document.activeElement === firstEl) {
			e.preventDefault();
			lastEl.focus();
		} else if (!e.shiftKey && document.activeElement === lastEl) {
			e.preventDefault();
			firstEl.focus();
		}
	}

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: the backdrop only forwards Escape from inside the dialog and closes on a click outside it.
		<div
			className={`absolute inset-0 z-20 flex bg-black/45 ${
				align === "bottom" ? "items-end" : "items-center px-4"
			}`}
			onKeyDown={onKeyDown}
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				ref={panel}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				aria-describedby={description ? descId : undefined}
				className={`w-full space-y-3 bg-background p-4 text-foreground shadow-lg ${
					align === "bottom" ? "rounded-t-2xl" : "rounded-xl"
				}`}
			>
				<h4 id={titleId} className="font-semibold text-base">
					{title}
				</h4>
				{description ? (
					<p id={descId} className="text-muted-foreground text-sm">
						{description}
					</p>
				) : null}
				{children}
			</div>
		</div>
	);
}

export function ClaimDemo() {
	const [slots, setSlots] = useState<readonly Slot[]>(INITIAL_SLOTS);
	const [me, setMe] = useState<string | null>(null);
	const [stage, setStage] = useState<Stage>("idle");
	const [pendingId, setPendingId] = useState<string | null>(null);
	const [title, setTitle] = useState("");
	const [announcement, setAnnouncement] = useState("");
	const [toast, setToast] = useState("");
	const [focusTarget, setFocusTarget] = useState<FocusTarget>(null);
	const opener = useRef<HTMLElement | null>(null);
	const buttons = useRef(new Map<string, HTMLButtonElement>());

	useEffect(() => {
		if (!focusTarget) return;
		buttons.current.get(`${focusTarget.id}:${focusTarget.kind}`)?.focus();
		setFocusTarget(null);
	}, [focusTarget]);

	useEffect(() => {
		if (!toast) return;
		const id = setTimeout(() => setToast(""), 2500);
		return () => clearTimeout(id);
	}, [toast]);

	const filled = slots.filter((s) => s.holder).length;
	const pending = slots.find((s) => s.id === pendingId) ?? null;

	function say(message: string) {
		setAnnouncement(message);
		setToast(message);
	}

	function startClaim(slot: Slot, el: HTMLElement) {
		opener.current = el;
		setPendingId(slot.id);
		setTitle("");
		setStage(me ? "sheet" : "who");
	}

	function closeOverlay() {
		setStage("idle");
		setPendingId(null);
		opener.current?.focus();
	}

	function pickName(name: string) {
		setMe(name);
		setStage("sheet");
	}

	function confirmClaim() {
		if (!pending || !me) return;
		const id = pending.id;
		setSlots((all) =>
			all.map((s) =>
				s.id === id
					? {
							...s,
							holder: me,
							title: s.speaker ? title.trim() || "TBA" : s.title,
						}
					: s,
			),
		);
		setStage("idle");
		setPendingId(null);
		say(`You claimed ${pending.role}.`);
		setFocusTarget({ id, kind: "release" });
	}

	function release(slot: Slot) {
		setSlots((all) =>
			all.map((s) =>
				s.id === slot.id
					? { ...s, holder: null, title: s.seeded ? s.title : undefined }
					: s,
			),
		);
		say(`You released ${slot.role}.`);
		setFocusTarget({ id: slot.id, kind: "claim" });
	}

	const register = (key: string) => (el: HTMLButtonElement | null) => {
		if (el) buttons.current.set(key, el);
		else buttons.current.delete(key);
	};

	return (
		<section
			aria-label="Try it: claim a role on the meeting page"
			className="flex flex-col items-center gap-3"
		>
			<div className="w-[320px] max-w-full rounded-[34px] bg-[#0e2a2e] p-2.5 shadow-[0_30px_70px_rgba(23,58,64,.26)]">
				<div className="relative min-h-[540px] overflow-hidden rounded-[27px] bg-background text-foreground">
					<div className="border-b bg-card px-4 pt-3.5 pb-3">
						<div className="font-extrabold text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
							Harbor City Speakers
						</div>
						<div className="mt-0.5 font-display font-semibold text-[17px]">
							Thursday's meeting
						</div>
						<div className="mt-2.5">
							<div className="mb-1 flex items-center justify-between text-muted-foreground text-xs">
								<span>
									Roles filled: {filled} of {slots.length}
								</span>
								<span>{Math.round((filled / slots.length) * 100)}%</span>
							</div>
							<div
								role="progressbar"
								aria-label="Roles filled"
								aria-valuemin={0}
								aria-valuemax={slots.length}
								aria-valuenow={filled}
								className="h-2 overflow-hidden rounded-full bg-muted"
							>
								<div
									className="h-full rounded-full bg-primary motion-safe:transition-[width]"
									style={{ width: `${(filled / slots.length) * 100}%` }}
								/>
							</div>
						</div>
					</div>
					<div className="space-y-2 p-3">
						<h3 className="font-semibold text-muted-foreground text-xs uppercase tracking-wide">
							Meeting roles
						</h3>
						<ul className="space-y-2">
							{slots.map((slot) => {
								const open = !slot.holder;
								const mine = !!me && slot.holder === me;
								return (
									<li
										key={slot.id}
										className="rounded-xl border bg-card p-3 shadow-sm"
									>
										<div className="flex items-start justify-between gap-3">
											<div className="min-w-0 flex-1">
												<p className="font-medium">{slot.role}</p>
												<p className="text-muted-foreground text-sm">
													{open ? (
														"Open"
													) : (
														<>
															{slot.holder}
															{mine ? (
																<span className="text-primary"> (you)</span>
															) : null}
														</>
													)}
												</p>
												{slot.speaker && slot.title ? (
													<div className="mt-1 text-sm">
														<p className="font-medium">
															&ldquo;{slot.title}&rdquo;
														</p>
														<p className="text-muted-foreground text-xs">
															{[
																slot.pathway,
																slot.min ? `${slot.min}–${slot.max} min` : null,
															]
																.filter(Boolean)
																.join(" · ")}
														</p>
													</div>
												) : null}
												{slot.evaluates ? (
													<p className="mt-1 text-muted-foreground text-xs">
														Evaluates{" "}
														<span className="font-medium text-foreground">
															{slot.evaluates}
														</span>
													</p>
												) : null}
											</div>
											<div className="flex shrink-0 flex-col items-end gap-1.5">
												{open ? (
													<Button
														ref={register(`${slot.id}:claim`)}
														size="sm"
														variant="outline"
														className="border-success/70 text-success hover:bg-success hover:text-success-foreground"
														aria-label={`Claim ${slot.role} — open`}
														onClick={(e) => startClaim(slot, e.currentTarget)}
													>
														Claim
													</Button>
												) : mine ? (
													<Button
														ref={register(`${slot.id}:release`)}
														size="sm"
														variant="outline"
														onClick={() => release(slot)}
													>
														Release
													</Button>
												) : (
													<Badge variant="secondary">Filled</Badge>
												)}
											</div>
										</div>
									</li>
								);
							})}
						</ul>
					</div>

					{toast ? (
						<div
							aria-hidden
							className="absolute right-3 bottom-3 left-3 z-10 rounded-lg bg-primary px-3 py-2.5 text-primary-foreground text-sm shadow-lg motion-safe:animate-in motion-safe:fade-in"
						>
							{toast}
						</div>
					) : null}

					{stage === "who" ? (
						<FrameOverlay
							align="center"
							title="Who are you?"
							description="Pick your name to continue. This just tags what you sign up for — no account needed."
							onClose={closeOverlay}
						>
							<div className="flex flex-col gap-1.5">
								{CLAIM_DEMO_NAMES.map((name) => (
									<Button
										key={name}
										variant="outline"
										className="justify-start"
										onClick={() => pickName(name)}
									>
										{name}
									</Button>
								))}
							</div>
							<div className="space-y-1 text-sm">
								<p className="font-medium">Don't see your name?</p>
								<p className="text-muted-foreground">
									Visiting us today? Sign the guest book and we'll say hello.
									Just joined the club? Ask an officer to add you to the roster.
								</p>
							</div>
						</FrameOverlay>
					) : null}

					{stage === "sheet" && pending ? (
						<FrameOverlay
							align="bottom"
							title={pending.role}
							description={
								pending.speaker
									? undefined
									: `You'll be the ${pending.role} on Thursday.`
							}
							onClose={closeOverlay}
						>
							{pending.speaker ? (
								<form
									className="space-y-3"
									onSubmit={(e) => {
										e.preventDefault();
										confirmClaim();
									}}
								>
									<div className="space-y-2">
										<Label htmlFor="claim-demo-title">Speech title</Label>
										<Input
											id="claim-demo-title"
											name="speechTitle"
											value={title}
											onChange={(e) => setTitle(e.target.value)}
											placeholder="TBA if not decided yet"
										/>
										<p className="text-muted-foreground text-xs">
											Min {pending.min} · Max {pending.max} minutes
										</p>
									</div>
									<div className="flex justify-end gap-2">
										<Button
											type="button"
											variant="outline"
											onClick={closeOverlay}
										>
											Cancel
										</Button>
										<Button type="submit">Claim speaking slot</Button>
									</div>
								</form>
							) : (
								<div className="flex justify-end gap-2">
									<Button
										type="button"
										variant="outline"
										onClick={closeOverlay}
									>
										Cancel
									</Button>
									<Button type="button" onClick={confirmClaim}>
										Claim
									</Button>
								</div>
							)}
						</FrameOverlay>
					) : null}
				</div>
			</div>
			{/* <output> is a polite status region by default. */}
			<output aria-live="polite" className="sr-only">
				{announcement}
			</output>
		</section>
	);
}
