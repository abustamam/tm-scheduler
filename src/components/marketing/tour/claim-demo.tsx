import { useState } from "react";

/**
 * Scene 1 of `/tour` (#867): the member's role list, drawn the way `/`'s
 * `MemberRoleList` draws it, but with working "Claim" buttons.
 *
 * Local state only. Nothing is sent anywhere and nothing survives a reload: it
 * is a drawing you can poke, not a client for the real sheet. Colours are the
 * semantic token pairs `MemberRoleList` documents (`bg-primary` /
 * `bg-success` with their foregrounds), so both themes stay legible. The one
 * raw colour is the device bezel, dark in both themes because phones are.
 */
export const CLAIM_DEMO_ROLES = [
	{ role: "Toastmaster", detail: "Runs the meeting" },
	{ role: "Speaker 2", detail: "5–7 min" },
	{ role: "Evaluator 1", detail: "Evaluates a speech" },
] as const;

/** Already taken, so the frame reads as a real sheet and not an empty one. */
const TAKEN = { role: "Ah-Counter", detail: "Marcus Lee" };

const ROW =
	"flex items-center justify-between gap-2.5 rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-2.5";
const CHIP =
	"shrink-0 rounded-full px-3 py-1.5 font-extrabold text-[12.5px] motion-safe:transition-colors motion-safe:duration-200 motion-safe:ease-out";

export function ClaimDemo() {
	const [claimed, setClaimed] = useState<ReadonlySet<string>>(new Set());

	return (
		<section
			aria-label="Try it: claim a role on the sign-up sheet"
			className="flex flex-col items-center gap-3"
		>
			<div className="w-[300px] max-w-full rounded-[34px] bg-[#0e2a2e] p-2.5 shadow-[0_30px_70px_rgba(23,58,64,.26)]">
				<div className="overflow-hidden rounded-[27px] bg-[var(--foam)]">
					<div className="border-[var(--line)] border-b bg-[var(--surface-strong)] px-4 pt-3.5 pb-3">
						<div className="font-extrabold text-[11.5px] text-[var(--sea-ink-soft)] uppercase tracking-[0.06em]">
							Harbor City Speakers
						</div>
						<div className="mt-0.5 font-display font-semibold text-[17px]">
							Tuesday's meeting
						</div>
					</div>
					<ul className="flex flex-col gap-[7px] p-[9px]">
						{CLAIM_DEMO_ROLES.map((r) => {
							const mine = claimed.has(r.role);
							return (
								<li key={r.role} className={ROW}>
									<div className="min-w-0">
										<div className="truncate font-bold text-[14px]">
											{r.role}
										</div>
										<div className="truncate text-[11.5px] text-[var(--sea-ink-soft)]">
											{r.detail}
										</div>
									</div>
									{mine ? (
										// The pop: tw-animate's enter animation from 1.08 back to
										// 1 over 300ms. `motion-safe:` only, so a reduced-motion
										// reader gets the same state change with no movement.
										<span
											className={`${CHIP} bg-success text-success-foreground motion-safe:animate-in motion-safe:zoom-in-[1.08] motion-safe:duration-300`}
										>
											You ✓
										</span>
									) : (
										<button
											type="button"
											aria-label={`Claim ${r.role}`}
											onClick={() =>
												setClaimed((prev) => new Set(prev).add(r.role))
											}
											className={`${CHIP} cursor-pointer bg-primary text-primary-foreground hover:opacity-90`}
										>
											Claim
										</button>
									)}
								</li>
							);
						})}
						<li className={ROW}>
							<div className="min-w-0">
								<div className="truncate font-bold text-[14px]">
									{TAKEN.role}
								</div>
								<div className="truncate text-[11.5px] text-[var(--sea-ink-soft)]">
									{TAKEN.detail}
								</div>
							</div>
							<span className={`${CHIP} bg-muted text-muted-foreground`}>
								Taken
							</span>
						</li>
					</ul>
				</div>
			</div>
			{/* Fixed height so the Reset link appearing does not shift the page. */}
			<div className="h-6">
				{claimed.size > 0 ? (
					<button
						type="button"
						onClick={() => setClaimed(new Set())}
						className="cursor-pointer font-semibold text-sm text-[var(--lagoon-deep)] underline-offset-2 hover:underline"
					>
						Reset
					</button>
				) : null}
			</div>
		</section>
	);
}
