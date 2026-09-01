import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { type ChangeEvent, useState } from "react";
import { toast } from "sonner";
import { PageContainer } from "#/components/page-container";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { ACCESS_REQUEST_MAILTO } from "#/lib/brand";
import { clubLogoUrl } from "#/lib/club-logo-url";
import { effectiveAdminClub } from "#/lib/effective-admin";
import {
	getClubLogoMeta,
	removeClubLogoFn,
	uploadClubLogo,
} from "#/server/club-logo";
import {
	getClubProfileSettings,
	loadClubAgendaSettings,
	loadClubTimezoneSettings,
	updateClubAgendaSettings,
	updateClubProfile,
	updateClubTimezone,
} from "#/server/clubs";
import {
	loadClubReminderSettings,
	updateClubReminderSettings,
} from "#/server/notification-prefs";

// Client-side pre-checks only — fast feedback before the upload round-trip.
// The server (`src/server/club-logo-logic.ts`, Lane A) is the authoritative
// check: same 256 KB decoded-byte cap, same MIME allowlist, plus a magic-byte
// check this client can't do. Keep these two numbers in sync with the server.
const MAX_LOGO_BYTES = 256 * 1024;
const ALLOWED_LOGO_TYPES = new Set(["image/png", "image/jpeg"]);

/** Read a File into the base64 string the upload server fn expects (no data: prefix). */
async function fileToBase64(file: File): Promise<string> {
	const buffer = await file.arrayBuffer();
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

/**
 * Every user-visible string in the Club logo section, in one place.
 *
 * ADR-0024 constraint 1 forbids naming any trademark in this feature's copy.
 * `club-logo-copy.guard.test.ts` greps THIS BLOCK rather than the whole file,
 * because the file legitimately says "Toastmaster of the Day" elsewhere
 * (nominative use, ADR-0024 decision 2). Keep all logo copy here so the guard
 * stays enforceable — a string inlined in JSX escapes it.
 */
export const CLUB_LOGO_COPY = {
	sectionTitle: "Club logo",
	sectionDescription: "Shown on the printed meeting agenda.",
	currentLabel: "Current logo",
	uploadCta: "Upload a logo",
	replaceCta: "Replace logo",
	emptyState: "No logo set yet.",
	selectedFilePrefix: "Selected: ",
	helpText: "PNG or JPEG, up to 256KB.",
	attestationLabel: "I confirm my club is authorized to use this image.",
	responsibilityNote:
		"Your club is responsible for the image it uploads. Questions?",
	contactLinkText: "Contact us.",
	saveCta: "Save club logo",
	removeCta: "Remove logo",
	uploadSuccess: "Club logo saved.",
	removeSuccess: "Club logo removed.",
	typeError: "Club logo must be a PNG or JPEG image.",
	sizeError: "Club logo must be 256KB or smaller.",
	genericError: "Something went wrong.",
} as const;

export const Route = createFileRoute("/_authed/admin/club-settings")({
	beforeLoad: ({ context }) => {
		const adminClub = effectiveAdminClub(context);
		if (!adminClub) {
			throw redirect({ to: "/dashboard" });
		}
		return { adminClub };
	},
	loader: async ({ context }) => {
		const [profile, reminders, agenda, logoMeta, timezone] = await Promise.all([
			getClubProfileSettings({ data: context.adminClub.clubId }),
			loadClubReminderSettings({ data: context.adminClub.clubId }),
			loadClubAgendaSettings({ data: context.adminClub.clubId }),
			getClubLogoMeta({ data: { clubId: context.adminClub.clubId } }),
			loadClubTimezoneSettings({ data: context.adminClub.clubId }),
		]);
		return { profile, reminders, agenda, logoMeta, timezone };
	},
	component: ClubSettings,
});

const textareaClass =
	"flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-sm";

// Native <select> styled to match the shadcn <Input> (no shadcn Select in ui/),
// matching /admin/roles and /admin/schedule.
const selectClass =
	"flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/**
 * "America/Chicago (GMT-5)" — the offset is what makes a 400-entry list
 * pickable, since an admin knows their offset far better than which IANA city
 * names their zone.
 *
 * Offsets are CURRENT, not fixed: a zone on summer time shows its summer
 * offset, which is the one that matches the admin's clock as they read it. The
 * zone id is what gets stored either way, so the label drifting across a DST
 * boundary changes nothing about the setting.
 *
 * The `try` is for a zone the SERVER's ICU lists and this browser's does not
 * resolve (the two builds' alias tables differ — see `CLUB_TIMEZONES`); such an
 * option stays selectable, just without an offset.
 */
function zoneLabel(zone: string): string {
	const name = zone.replace(/_/g, " ");
	try {
		const offset = new Intl.DateTimeFormat("en-US", {
			timeZone: zone,
			timeZoneName: "shortOffset",
		})
			.formatToParts(new Date())
			.find((p) => p.type === "timeZoneName")?.value;
		return offset ? `${name} (${offset})` : name;
	} catch {
		return name;
	}
}

function ClubSettings() {
	const { adminClub } = Route.useRouteContext();
	const { profile, reminders, agenda, logoMeta, timezone } =
		Route.useLoaderData();
	const router = useRouter();
	const [submitting, setSubmitting] = useState(false);
	const [remindersEnabled, setRemindersEnabled] = useState(reminders.enabled);
	const [leadTimeDays, setLeadTimeDays] = useState(
		String(reminders.leadTimeDays),
	);
	const [savingReminders, setSavingReminders] = useState(false);
	const [geIntroduces, setGeIntroduces] = useState(
		agenda.geIntroducesFunctionaries,
	);
	const [savingAgenda, setSavingAgenda] = useState(false);
	const [zone, setZone] = useState(timezone.timezone);
	const [savingZone, setSavingZone] = useState(false);
	const [logoFile, setLogoFile] = useState<File | null>(null);
	const [logoAttested, setLogoAttested] = useState(false);
	const [uploadingLogo, setUploadingLogo] = useState(false);
	const [removingLogo, setRemovingLogo] = useState(false);

	const logoSrc = logoMeta
		? clubLogoUrl(adminClub.clubId, logoMeta.updatedAt)
		: null;

	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const form = new FormData(e.currentTarget);
		setSubmitting(true);
		try {
			await updateClubProfile({
				data: {
					clubId: adminClub.clubId,
					district: String(form.get("district") ?? ""),
					mission: String(form.get("mission") ?? ""),
					meetingSchedule: String(form.get("meetingSchedule") ?? ""),
					defaultCountryCode: String(form.get("defaultCountryCode") ?? ""),
				},
			});
			toast.success("Club profile saved.");
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setSubmitting(false);
		}
	}

	async function onSaveReminders(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const days = Number.parseInt(leadTimeDays, 10);
		if (!Number.isFinite(days) || days < 0 || days > 60) {
			toast.error("Lead time must be a whole number of days (0–60).");
			return;
		}
		setSavingReminders(true);
		try {
			await updateClubReminderSettings({
				data: {
					clubId: adminClub.clubId,
					enabled: remindersEnabled,
					leadTimeDays: days,
				},
			});
			toast.success("Reminder settings saved.");
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setSavingReminders(false);
		}
	}

	async function onSaveAgenda(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		setSavingAgenda(true);
		try {
			await updateClubAgendaSettings({
				data: {
					clubId: adminClub.clubId,
					geIntroducesFunctionaries: geIntroduces,
				},
			});
			toast.success("Agenda settings saved.");
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setSavingAgenda(false);
		}
	}

	async function onSaveTimezone(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		setSavingZone(true);
		try {
			await updateClubTimezone({
				data: { clubId: adminClub.clubId, timezone: zone },
			});
			toast.success("Time zone saved.");
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setSavingZone(false);
		}
	}

	function onLogoFileChange(e: ChangeEvent<HTMLInputElement>) {
		const file = e.target.files?.[0] ?? null;
		// Allow re-selecting the same file later (onChange won't fire otherwise).
		e.target.value = "";
		if (!file) return;
		// Fast client-side feedback only — the server re-checks both (and adds a
		// magic-byte check this client can't do), so a check removed here can
		// only make the error slower to surface, never let a bad file through.
		if (!ALLOWED_LOGO_TYPES.has(file.type)) {
			toast.error(CLUB_LOGO_COPY.typeError);
			return;
		}
		if (file.size > MAX_LOGO_BYTES) {
			toast.error(CLUB_LOGO_COPY.sizeError);
			return;
		}
		setLogoFile(file);
		// Re-required for the new file, including a replacement of an existing logo.
		setLogoAttested(false);
	}

	async function onUploadLogo(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		if (!logoFile || !logoAttested) return;
		setUploadingLogo(true);
		try {
			const base64 = await fileToBase64(logoFile);
			await uploadClubLogo({
				data: {
					clubId: adminClub.clubId,
					base64,
					mime: logoFile.type,
					attested: logoAttested,
				},
			});
			toast.success(CLUB_LOGO_COPY.uploadSuccess);
			setLogoFile(null);
			setLogoAttested(false);
			await router.invalidate();
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : CLUB_LOGO_COPY.genericError,
			);
		} finally {
			setUploadingLogo(false);
		}
	}

	async function onRemoveLogo() {
		setRemovingLogo(true);
		try {
			await removeClubLogoFn({ data: { clubId: adminClub.clubId } });
			toast.success(CLUB_LOGO_COPY.removeSuccess);
			await router.invalidate();
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : CLUB_LOGO_COPY.genericError,
			);
		} finally {
			setRemovingLogo(false);
		}
	}

	return (
		<PageContainer className="space-y-4">
			<div>
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
					Club settings
				</h1>
				<p className="text-sm text-muted-foreground">
					District, mission, and meeting schedule for{" "}
					{profile?.name ?? adminClub.name}. These appear on the printable
					meeting agenda. Leave a field blank to omit it.
				</p>
			</div>

			<form onSubmit={onSubmit} className="max-w-xl space-y-4">
				<div className="space-y-2">
					<Label htmlFor="district">District</Label>
					<Input
						id="district"
						name="district"
						defaultValue={profile?.district ?? ""}
						placeholder="e.g. District 39"
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="meetingSchedule">Meeting schedule</Label>
					<Input
						id="meetingSchedule"
						name="meetingSchedule"
						defaultValue={profile?.meetingSchedule ?? ""}
						placeholder="e.g. 2nd & 4th Thursday, 6:45–7:45 PM"
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="mission">Mission</Label>
					<textarea
						id="mission"
						name="mission"
						rows={4}
						defaultValue={profile?.mission ?? ""}
						className={textareaClass}
						placeholder="Your club's mission statement"
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="defaultCountryCode">Default country code</Label>
					<Input
						id="defaultCountryCode"
						name="defaultCountryCode"
						defaultValue={profile?.defaultCountryCode ?? ""}
						placeholder="+1"
					/>
					<p className="text-xs text-muted-foreground">
						Added to member and guest phone numbers that don't include a country
						code, so the "Nudge on WhatsApp" links work and the same number
						typed two ways is recognized as one person. Leave blank to use +1
						(US/Canada) — set yours if your club is elsewhere.
					</p>
				</div>
				<Button type="submit" disabled={submitting} className="w-full">
					{submitting ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						"Save club profile"
					)}
				</Button>
			</form>

			<div className="pt-2">
				<h2 className="font-display text-xl font-semibold tracking-[-0.01em]">
					Time zone
				</h2>
				<p className="text-sm text-muted-foreground">
					The zone your club meets in. Every meeting time, date and deadline in
					the app is shown and interpreted in it.
				</p>
			</div>

			<form onSubmit={onSaveTimezone} className="max-w-xl space-y-4">
				<div className="space-y-2">
					<Label htmlFor="timezone">Club time zone</Label>
					<select
						id="timezone"
						name="timezone"
						className={selectClass}
						value={zone}
						onChange={(e) => setZone(e.target.value)}
					>
						{timezone.zones.map((z) => (
							<option key={z} value={z}>
								{zoneLabel(z)}
							</option>
						))}
					</select>
					<p className="text-xs text-muted-foreground">
						Changing this re-labels meetings that already exist: the times
						themselves don't move, but the dates shown against them — and the
						dated links to them — are recalculated in the new zone, so a meeting
						link shared earlier may stop working.
					</p>
				</div>
				<Button type="submit" disabled={savingZone} className="w-full">
					{savingZone ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						"Save time zone"
					)}
				</Button>
			</form>

			<div className="pt-2">
				<h2 className="font-display text-xl font-semibold tracking-[-0.01em]">
					Role reminders
				</h2>
				<p className="text-sm text-muted-foreground">
					Email members a reminder before a meeting when they're signed up for a
					role. Members can opt out individually. Off by club here disables role
					reminders entirely.
				</p>
			</div>

			<form onSubmit={onSaveReminders} className="max-w-xl space-y-4">
				<label className="flex items-center gap-2 text-sm font-medium">
					<input
						type="checkbox"
						checked={remindersEnabled}
						onChange={(e) => setRemindersEnabled(e.target.checked)}
					/>
					Send role reminders for this club
				</label>
				<div className="space-y-2">
					<Label htmlFor="leadTimeDays">
						Lead time (days before the meeting)
					</Label>
					<Input
						id="leadTimeDays"
						name="leadTimeDays"
						type="number"
						min={0}
						max={60}
						inputMode="numeric"
						value={leadTimeDays}
						onChange={(e) => setLeadTimeDays(e.target.value)}
						disabled={!remindersEnabled}
						className="max-w-[10rem]"
					/>
					<p className="text-xs text-muted-foreground">
						e.g. 3 = remind members three days before the meeting.
					</p>
				</div>
				<Button type="submit" disabled={savingReminders} className="w-full">
					{savingReminders ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						"Save reminder settings"
					)}
				</Button>
			</form>

			<div className="pt-2">
				<h2 className="font-display text-xl font-semibold tracking-[-0.01em]">
					Meeting agenda
				</h2>
				<p className="text-sm text-muted-foreground">
					How your club runs its meeting, on the generated agenda and the
					projected slides.
				</p>
			</div>

			<form onSubmit={onSaveAgenda} className="max-w-xl space-y-4">
				<div className="space-y-2">
					<label className="flex items-center gap-2 text-sm font-medium">
						<input
							type="checkbox"
							checked={geIntroduces}
							onChange={(e) => setGeIntroduces(e.target.checked)}
						/>
						General Evaluator introduces the functionaries
					</label>
					<p className="text-xs text-muted-foreground">
						Most clubs have the Toastmaster of the Day introduce the Timer,
						Ah-Counter, Grammarian and Vote Counter at the top of the meeting,
						each explaining their own role. Tick this if your General Evaluator
						does it instead. Either way the General Evaluator still calls for
						their reports near the end.
					</p>
				</div>
				<Button type="submit" disabled={savingAgenda} className="w-full">
					{savingAgenda ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						"Save agenda settings"
					)}
				</Button>
			</form>

			<div className="pt-2">
				<h2 className="font-display text-xl font-semibold tracking-[-0.01em]">
					{CLUB_LOGO_COPY.sectionTitle}
				</h2>
				<p className="text-sm text-muted-foreground">
					{CLUB_LOGO_COPY.sectionDescription}
				</p>
			</div>

			<form onSubmit={onUploadLogo} className="max-w-xl space-y-4">
				<div className="space-y-2">
					<Label>{CLUB_LOGO_COPY.currentLabel}</Label>
					{logoSrc ? (
						<img
							src={logoSrc}
							alt=""
							data-testid="club-logo-preview"
							className="h-16 w-auto max-w-[12rem] rounded-md border border-input object-contain p-2"
						/>
					) : (
						<p className="text-sm text-muted-foreground">
							{CLUB_LOGO_COPY.emptyState}
						</p>
					)}
				</div>

				<div className="space-y-2">
					<Label htmlFor="logoFile">
						{logoSrc ? CLUB_LOGO_COPY.replaceCta : CLUB_LOGO_COPY.uploadCta}
					</Label>
					<Input
						id="logoFile"
						name="logoFile"
						type="file"
						accept="image/png,image/jpeg"
						onChange={onLogoFileChange}
					/>
					{logoFile ? (
						<p className="text-xs text-muted-foreground">
							{CLUB_LOGO_COPY.selectedFilePrefix}
							{logoFile.name}
						</p>
					) : null}
					<p className="text-xs text-muted-foreground">
						{CLUB_LOGO_COPY.helpText}
					</p>
				</div>

				<label className="flex items-center gap-2 text-sm font-medium">
					<input
						type="checkbox"
						checked={logoAttested}
						onChange={(e) => setLogoAttested(e.target.checked)}
					/>
					{CLUB_LOGO_COPY.attestationLabel}
				</label>

				<p className="text-xs text-muted-foreground">
					{CLUB_LOGO_COPY.responsibilityNote}{" "}
					<a href={ACCESS_REQUEST_MAILTO} className="underline">
						{CLUB_LOGO_COPY.contactLinkText}
					</a>
				</p>

				<div className="flex gap-2">
					<Button
						type="submit"
						disabled={!logoFile || !logoAttested || uploadingLogo}
						className="flex-1"
					>
						{uploadingLogo ? (
							<Loader2 className="size-4 animate-spin" />
						) : (
							CLUB_LOGO_COPY.saveCta
						)}
					</Button>
					{logoSrc ? (
						<Button
							type="button"
							variant="outline"
							onClick={onRemoveLogo}
							disabled={removingLogo}
						>
							{removingLogo ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								CLUB_LOGO_COPY.removeCta
							)}
						</Button>
					) : null}
				</div>
			</form>
		</PageContainer>
	);
}
