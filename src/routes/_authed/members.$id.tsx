import {
	createFileRoute,
	Link,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { MemberAvatar } from "#/components/club/member-avatar";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { initialsOf, toneFromSeed } from "#/lib/avatar";
import { formatTenure } from "#/lib/members";
import { getMemberProfile } from "#/server/club";
import { editMember, removeMember } from "#/server/members";

export const Route = createFileRoute("/_authed/members/$id")({
	loader: async ({ params, context }) => {
		const clubId = context.clubs[0]?.clubId;
		if (!clubId) {
			return { member: null, speechLog: [], rolesServed: [], speeches: 0 };
		}
		return getMemberProfile({ data: { clubId, memberId: params.id } });
	},
	component: MemberDetail,
});

function joinedLabel(value: Date | string) {
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		year: "numeric",
	}).format(new Date(value));
}

function dayMon(value: Date | string) {
	const d = new Date(value);
	return {
		day: new Intl.DateTimeFormat(undefined, { day: "numeric" }).format(d),
		mon: new Intl.DateTimeFormat(undefined, { month: "short" })
			.format(d)
			.toUpperCase(),
	};
}

function MemberDetail() {
	const { member, speechLog, rolesServed } = Route.useLoaderData();
	const { clubs, currentMemberId } = Route.useRouteContext();
	const clubId = clubs[0]?.clubId;

	if (!member) {
		return (
			<div className="max-w-[1180px] px-7 pt-[22px] pb-10">
				<BackLink />
				<h1 className="mt-5 font-display text-[28px] font-semibold">
					Member not found
				</h1>
			</div>
		);
	}

	// Identity, speech log and roles served are real; Pathways progress is not modeled (#61).
	const joined = member.joinedAt ?? member.createdAt;
	const tenure = member.office
		? `${formatTenure(joined)} · ${member.office}`
		: formatTenure(joined);

	return (
		<div className="max-w-[1180px] px-7 pt-[22px] pb-10">
			<BackLink />

			{/* Header */}
			<div className="mt-[18px] mb-6 flex flex-wrap items-center gap-[18px]">
				<MemberAvatar
					tone={toneFromSeed(member.id)}
					initials={initialsOf(member.name)}
					size={66}
					className="shadow-[0_6px_16px_rgba(23,58,64,.18)]"
				/>
				<div className="min-w-[220px] flex-1">
					<h1 className="font-display text-[28px] font-semibold tracking-[-0.02em]">
						{member.name}
					</h1>
					<div className="mt-1.5 flex flex-wrap items-center gap-2.5">
						<span className="text-[13.5px] text-[var(--sea-ink-soft)]">
							{tenure} · joined {joinedLabel(joined)}
						</span>
					</div>
				</div>
				<div className="flex flex-wrap gap-[9px]">
					<Button asChild size="sm">
						<Link to="/agenda">Assign a role</Link>
					</Button>
					{clubId ? (
						<MemberActions
							member={member}
							clubId={clubId}
							currentMemberId={currentMemberId}
						/>
					) : null}
				</div>
			</div>

			{/* Speech log (real) + side cards */}
			<div className="grid grid-cols-1 items-start gap-[18px] lg:grid-cols-[1.5fr_1fr]">
				{/* Speech log */}
				<div className="min-w-0 overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] shadow-[0_1px_0_var(--inset-glint)_inset,0_10px_24px_rgba(23,58,64,.05)]">
					<div className="flex items-center justify-between px-5 pt-4 pb-3">
						<h2 className="text-[15px] font-bold">Speech log</h2>
						<span className="text-xs text-[var(--sea-ink-soft)]">
							most recent {speechLog.length}
						</span>
					</div>
					{speechLog.length === 0 ? (
						<p className="border-t border-[var(--line)] px-5 py-8 text-center text-[13px] text-[var(--sea-ink-soft)]">
							No speeches logged yet.
						</p>
					) : (
						speechLog.map((l) => {
							const { day, mon } = dayMon(l.scheduledAt);
							const scheduled = new Date(l.scheduledAt).getTime() > Date.now();
							const sub = [l.projectName, l.pathwayPath, l.projectLevel]
								.filter(Boolean)
								.join(" · ");
							return (
								<div
									key={l.slotId}
									className="grid grid-cols-[54px_1fr_auto] items-center gap-3 border-t border-[var(--line)] px-5 py-3 transition-colors hover:bg-[var(--foam)]"
								>
									<div className="text-center leading-[1.1]">
										<div className="font-display text-[17px] font-semibold">
											{day}
										</div>
										<div className="text-[10px] font-bold tracking-[0.05em] text-[var(--sea-ink-soft)]">
											{mon}
										</div>
									</div>
									<div className="min-w-0">
										<div className="truncate text-[13.5px] font-bold">
											{l.speechTitle ?? l.roleName}
										</div>
										<div className="truncate text-[11.5px] text-[var(--sea-ink-soft)]">
											{sub ||
												(l.evaluatorName
													? `Evaluated by ${l.evaluatorName}`
													: l.roleName)}
										</div>
									</div>
									{scheduled ? (
										<span className="shrink-0 rounded-full bg-[rgba(79,184,178,.16)] px-2.5 py-1 text-[11px] font-bold text-[var(--lagoon-deep)]">
											Scheduled
										</span>
									) : (
										<span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--foam)] px-2.5 py-1 text-[11px] font-semibold text-[var(--palm)]">
											Completed
										</span>
									)}
								</div>
							);
						})
					)}
				</div>

				{/* Side cards */}
				<div className="flex min-w-0 flex-col gap-[18px]">
					<div className="rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] px-5 py-[18px] shadow-[0_1px_0_var(--inset-glint)_inset,0_10px_24px_rgba(23,58,64,.05)]">
						<h2 className="mb-3 text-[15px] font-bold">
							Roles served this year
						</h2>
						{rolesServed.length === 0 ? (
							<p className="text-[12.5px] text-[var(--sea-ink-soft)]">
								No roles served yet this year.
							</p>
						) : (
							<div className="flex flex-wrap gap-2">
								{rolesServed.map((r) => (
									<span
										key={r.name}
										className="inline-flex items-center gap-[7px] rounded-full border border-[var(--line)] bg-[var(--foam)] px-[11px] py-1.5 text-xs font-semibold"
									>
										{r.name}
										<span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--sand)] px-[5px] text-[10.5px] font-bold text-[var(--sea-ink-soft)]">
											{r.count}
										</span>
									</span>
								))}
							</div>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

type ProfileMember = {
	id: string;
	name: string;
	email: string | null;
	phone: string | null;
	office: string | null;
	userId: string | null;
};

function MemberActions({
	member,
	clubId,
	currentMemberId,
}: {
	member: ProfileMember;
	clubId: string;
	currentMemberId: string | null;
}) {
	const router = useRouter();
	const navigate = useNavigate();
	const [editOpen, setEditOpen] = useState(false);
	const [removeOpen, setRemoveOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const isLinkedAccount = Boolean(member.userId);

	async function onEditSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const form = new FormData(e.currentTarget);
		const name = String(form.get("name") ?? "").trim();
		if (!name) {
			toast.error("Name is required.");
			return;
		}
		setBusy(true);
		try {
			await editMember({
				data: {
					clubId,
					memberId: member.id,
					actorMemberId: currentMemberId,
					name,
					email: String(form.get("email") ?? "").trim() || null,
					phone: String(form.get("phone") ?? "").trim() || null,
					office: String(form.get("office") ?? "").trim() || null,
				},
			});
			toast.success("Member updated.");
			setEditOpen(false);
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusy(false);
		}
	}

	async function onRemove() {
		setBusy(true);
		try {
			await removeMember({
				data: { clubId, memberId: member.id, actorMemberId: currentMemberId },
			});
			toast.success(`${member.name} removed from the roster.`);
			setRemoveOpen(false);
			await navigate({ to: "/" });
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
				Edit
			</Button>
			{!isLinkedAccount ? (
				<Button
					variant="outline"
					size="sm"
					className="border-[var(--line)] text-[var(--danger,#b4232a)] hover:bg-[rgba(180,35,42,.08)]"
					onClick={() => setRemoveOpen(true)}
				>
					Remove
				</Button>
			) : null}

			{/* Edit dialog */}
			<Dialog open={editOpen} onOpenChange={setEditOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Edit member</DialogTitle>
						<DialogDescription>
							Update {member.name}'s name and contact details.
						</DialogDescription>
					</DialogHeader>
					<form onSubmit={onEditSubmit} className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="edit-name">Name</Label>
							<Input
								id="edit-name"
								name="name"
								required
								defaultValue={member.name}
								autoFocus
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="edit-email">Email</Label>
							<Input
								id="edit-email"
								name="email"
								type="email"
								defaultValue={member.email ?? ""}
								placeholder="name@example.com"
							/>
						</div>
						<div className="grid grid-cols-2 gap-3">
							<div className="space-y-2">
								<Label htmlFor="edit-phone">Phone</Label>
								<Input
									id="edit-phone"
									name="phone"
									type="tel"
									defaultValue={member.phone ?? ""}
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="edit-office">Office</Label>
								<Input
									id="edit-office"
									name="office"
									defaultValue={member.office ?? ""}
									placeholder="e.g. VP Education"
								/>
							</div>
						</div>
						<DialogFooter>
							<DialogClose asChild>
								<Button type="button" variant="outline" disabled={busy}>
									Cancel
								</Button>
							</DialogClose>
							<Button type="submit" disabled={busy}>
								{busy ? "Saving…" : "Save changes"}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>

			{/* Remove confirm dialog */}
			<Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Remove {member.name}?</DialogTitle>
						<DialogDescription>
							Their upcoming roles will be released. This can't be undone.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<DialogClose asChild>
							<Button type="button" variant="outline" disabled={busy}>
								Cancel
							</Button>
						</DialogClose>
						<Button
							type="button"
							variant="destructive"
							disabled={busy}
							onClick={onRemove}
						>
							{busy ? "Removing…" : "Remove member"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

function BackLink() {
	return (
		<Link
			to="/"
			className="group inline-flex items-center gap-[7px] text-[13px] font-semibold text-[var(--sea-ink-soft)] no-underline transition-colors hover:text-[var(--sea-ink)]"
		>
			<ChevronLeft
				className="size-[15px] transition-transform group-hover:-translate-x-0.5"
				aria-hidden
			/>
			Back to roster
		</Link>
	);
}
