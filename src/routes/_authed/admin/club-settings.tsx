import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { type ChangeEvent, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PageContainer } from "#/components/page-container";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { ACCESS_REQUEST_MAILTO } from "#/lib/brand";
import {
	ALLOWED_LOGO_MIME_TYPES,
	isAllowedLogoMime,
	MAX_LOGO_BYTES,
	MAX_LOGO_DIMENSION,
	MAX_LOGO_KB,
} from "#/lib/club-logo-limits";
import { clubLogoUrl } from "#/lib/club-logo-url";
import { effectiveAdminClub } from "#/lib/effective-admin";
import {
	type ImageDimensions,
	readImageDimensions,
} from "#/lib/image-dimensions";
import {
	formatTableTopicsClock,
	MAX_TABLE_TOPICS_SECONDS,
	refusalAfterEdit,
	TABLE_TOPICS_DEFAULT_TIMING,
	type TableTopicsField,
	type TableTopicsRefusal,
	tableTopicsClockText,
	validateTableTopicsForm,
} from "#/lib/table-topics-limits";
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
// The server (`src/server/club-logo-logic.ts`) is the authoritative check: the
// same limits, the same header parser, plus a magic-byte sniff this client
// doesn't repeat. Nothing here is re-declared; why that matters is in
// `#/lib/club-logo-limits`.

/**
 * The selected image's intrinsic size, or null when we can't tell.
 *
 * Reads the file's HEADER through the same `#/lib/image-dimensions` parser the
 * server runs, rather than decoding the image. `createImageBitmap` was the
 * first cut of this and was the wrong tool twice over: it cost 52.9 ms and
 * 244 MB of renderer RSS on the 8000x8000 / 243 KiB PNG the cap exists for
 * (measured in headless Chrome) — a full decode, on the REJECT path, to learn
 * two numbers — and being a different implementation from the server's parser
 * it could disagree with it about the same file, silently, with every gate
 * green. One shared function removes both problems.
 *
 * The WHOLE file is read, not a prefix: the parser walks to IEND to prove the
 * structure, so a truncated slice returns null. That is affordable because the
 * byte cap is checked before this runs, so `file` is already under
 * `MAX_LOGO_BYTES` — 256 KiB of `ArrayBuffer`, no decode, nothing retained.
 *
 * Null means "don't block". This is a shortcut to the error message, never the
 * gate: the server re-runs this exact parser plus a magic-byte sniff, and its
 * messages distinguish "not a valid PNG or JPEG" from a size problem.
 */
async function readImageSize(file: File): Promise<ImageDimensions | null> {
	try {
		const bytes = new Uint8Array(await file.arrayBuffer());
		return readImageDimensions(bytes, file.type);
	} catch {
		return null;
	}
}

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
 *
 * Every limit named in this copy is INTERPOLATED from `#/lib/club-logo-limits`,
 * never typed out (#504). A hardcoded "up to 256KB" is a second declaration of
 * the cap wearing prose, and it goes stale the same silent way the constants
 * did. `club-settings.test.tsx`'s "logo copy is derived from the shared limits"
 * block asserts these strings still contain the values the checks use AND that
 * the help text reaches the DOM — the string alone proves nothing to a user.
 */
export const CLUB_LOGO_COPY = {
	sectionTitle: "Club logo",
	sectionDescription: "Shown on the printed meeting agenda.",
	currentLabel: "Current logo",
	uploadCta: "Upload a logo",
	replaceCta: "Replace logo",
	emptyState: "No logo set yet.",
	selectedFilePrefix: "Selected: ",
	helpText: `PNG or JPEG. Max ${MAX_LOGO_KB} KB, and no larger than ${MAX_LOGO_DIMENSION} x ${MAX_LOGO_DIMENSION} pixels.`,
	attestationLabel: "I confirm my club is authorized to use this image.",
	responsibilityNote:
		"Your club is responsible for the image it uploads. Questions?",
	contactLinkText: "Contact us.",
	saveCta: "Save club logo",
	removeCta: "Remove logo",
	uploadSuccess: "Club logo saved.",
	removeSuccess: "Club logo removed.",
	typeError: "Club logo must be a PNG or JPEG image.",
	sizeError: `Club logo must be ${MAX_LOGO_KB} KB or smaller.`,
	// A function, so the client can name the size it measured the way the server
	// does (`club-logo-logic.ts` appends the same parenthetical). The two paths
	// are both live for one file — a browser this parser can't read falls through
	// to the server — so they should read as one message, not two.
	dimensionError: (size: ImageDimensions | null) =>
		`Club logo must be ${MAX_LOGO_DIMENSION} x ${MAX_LOGO_DIMENSION} pixels or smaller${
			size ? ` (this one is ${size.width} x ${size.height})` : ""
		}.`,
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
			// Degrades to "no logo" rather than blanking the whole settings page,
			// matching the five public logo loaders, which already catch. It
			// matters across a rolling deploy: a server fn's URL is derived from
			// file+name, not content, so a tab left open across #504's POST->GET
			// flip keeps POSTing to a URL that now answers 405.
			getClubLogoMeta({ data: { clubId: context.adminClub.clubId } }).catch(
				() => null,
			),
			loadClubTimezoneSettings({ data: context.adminClub.clubId }),
		]);
		return { profile, reminders, agenda, logoMeta, timezone };
	},
	component: ClubSettings,
});

const textareaClass =
	"flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-sm";

/**
 * Native <select> styled to match the shadcn <Input> (there is no shadcn Select
 * in `ui/`).
 *
 * Tracks `input.tsx`'s CURRENT classes rather than copying the older string in
 * `/admin/roles`, `/admin/schedule` and `/admin/meetings/batch`, which has
 * drifted: those three predate the `shadow-xs` / 3px tinted focus ring /
 * `dark:bg-input/30` styling and sit among other selects, where the difference
 * is invisible. This select sits directly among Input-styled text fields
 * (District, Meeting schedule, Default country code), so a thin single-colour
 * focus ring and a flat dark background read as a bug. Those three copies are
 * recorded in TODOS.md rather than changed here.
 *
 * `text-base md:text-sm`, not a bare `text-sm`: iOS Safari auto-zooms the page
 * when a form control under 16px takes focus, and this control opens a
 * 400-entry picker — the one place on the page where that zoom is most
 * disruptive.
 */
const selectClass =
	"flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

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
 *
 * Exported only so the degraded paths are reachable from a test: both of them
 * depend on how the BROWSER's `Intl` answers, which cannot be provoked through
 * a rendered select without stubbing `Intl` for the whole render.
 */
export function zoneLabel(zone: string): string {
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
	// Held as the TEXT the admin typed, not as parsed seconds: a controlled
	// number field that reformats mid-keystroke fights the person typing "2:30"
	// the moment they have typed "2:". Seeded through `tableTopicsClockText`
	// rather than by an inline conditional, because nothing in this file is
	// reachable from vitest and the rule it carries — a null column renders EMPTY,
	// never `0:00` — is the difference between "this club states no window" and
	// "this club's minimum is zero seconds" (#679).
	const [ttMin, setTtMin] = useState(
		tableTopicsClockText(agenda.tableTopicsMinSeconds),
	);
	const [ttMax, setTtMax] = useState(
		tableTopicsClockText(agenda.tableTopicsMaxSeconds),
	);
	/** The last refusal, kept WHOLE rather than as a field name. The toast says
	 *  the sentence once and disappears; the field keeps `aria-invalid` but a bare
	 *  red border is not a reason, so the message is also rendered under the input
	 *  it belongs to and pointed at by `aria-describedby`. */
	const [ttRefusal, setTtRefusal] = useState<TableTopicsRefusal | null>(null);
	/** Which refusal survives an edit is `refusalAfterEdit`'s rule, not this
	 *  file's — see it for why touching the OTHER field must leave the marker
	 *  standing. Written inline here in the first cut of #679, which is the exact
	 *  mistake #679 exists to correct, one scale down. */
	const clearTtRefusal = (field: TableTopicsField) =>
		setTtRefusal((prev) => refusalAfterEdit(prev, field));
	const [zone, setZone] = useState(timezone.timezone);
	const [savingZone, setSavingZone] = useState(false);
	/**
	 * Memoized because this whole page is ONE component: the lead-time input and
	 * three checkboxes are all controlled state here, so without this every
	 * keystroke and every toggle would rebuild ~420 labels, each constructing an
	 * `Intl.DateTimeFormat` (~28ms measured). `timezone.zones` is loader data and
	 * referentially stable between renders, so the list is built once per load.
	 */
	const zoneOptions = useMemo(
		() => timezone.zones.map((z) => ({ value: z, label: zoneLabel(z) })),
		[timezone.zones],
	);
	const [logoFile, setLogoFile] = useState<File | null>(null);
	const [logoAttested, setLogoAttested] = useState(false);
	// Monotonic selection counter — see `onLogoFileChange`. A ref, not state: it
	// must not re-render, and a superseded pick has to read the CURRENT value
	// after its await, which a captured state value cannot give it.
	const logoPickSeq = useRef(0);
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
		// Validated BEFORE the request, so a typo is caught where the admin can see
		// which field is wrong rather than coming back as a server error on a form
		// that has already been submitted. The four branches used to be written out
		// here, where nothing can test them — and the ceiling check was missing for
		// exactly as long as that was true (#679).
		const result = validateTableTopicsForm(ttMin, ttMax);
		if (!result.ok) {
			setTtRefusal({ field: result.field, message: result.message });
			toast.error(result.message);
			return;
		}
		setTtRefusal(null);
		setSavingAgenda(true);
		try {
			await updateClubAgendaSettings({
				data: {
					clubId: adminClub.clubId,
					geIntroducesFunctionaries: geIntroduces,
					tableTopicsMinSeconds: result.minSeconds,
					tableTopicsMaxSeconds: result.maxSeconds,
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

	async function onLogoFileChange(e: ChangeEvent<HTMLInputElement>) {
		const file = e.target.files?.[0] ?? null;
		// Allow re-selecting the same file later (onChange won't fire otherwise).
		e.target.value = "";
		if (!file) return;

		// A rejected pick must not leave the PREVIOUS one staged. The native input
		// was just cleared above, so a surviving "Selected: old.png" is the only
		// thing on screen saying what Save would send — and it would send a file
		// the admin thinks they replaced, still carrying its earlier attestation.
		function reject(message: string) {
			toast.error(message);
			setLogoFile(null);
			setLogoAttested(false);
		}

		// Fast client-side feedback only — the server re-checks all three (and
		// adds a magic-byte sniff this client can't do), so a check removed here
		// can only make the error slower to surface, never let a bad file through.
		if (!isAllowedLogoMime(file.type)) {
			reject(CLUB_LOGO_COPY.typeError);
			return;
		}
		if (file.size > MAX_LOGO_BYTES) {
			reject(CLUB_LOGO_COPY.sizeError);
			return;
		}
		// The pixel cap, which the client didn't know about at all until #504:
		// bytes don't bound dimensions (a 4000x3000 transparent PNG fits inside
		// the byte cap easily), so without this the admin base64s the whole file
		// and learns it's too big only from the server's reply.
		//
		// `pick` guards re-entrancy: reading the file is async, so a second
		// selection can start before this one resolves and the two would commit in
		// RESOLUTION order rather than selection order.
		const pick = ++logoPickSeq.current;
		const size = await readImageSize(file);
		if (pick !== logoPickSeq.current) return;
		if (
			size &&
			(size.width > MAX_LOGO_DIMENSION || size.height > MAX_LOGO_DIMENSION)
		) {
			reject(CLUB_LOGO_COPY.dimensionError(size));
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
					<Label htmlFor="timezone">Time zone</Label>
					<select
						id="timezone"
						name="timezone"
						className={selectClass}
						value={zone}
						onChange={(e) => setZone(e.target.value)}
					>
						{zoneOptions.map((o) => (
							<option key={o.value} value={o.value}>
								{o.label}
							</option>
						))}
					</select>
					<p className="text-xs text-muted-foreground">
						Meeting times won't change, but their dates might — dates are shown
						in whichever zone you pick here. If you've already shared a link to
						a meeting, re-share it after saving: the old link may stop working.
					</p>
				</div>
				{/* The label is swapped for a spinner while saving, so a role+name
				    query cannot find this button in exactly the state worth
				    asserting. The testid is the stable handle. */}
				<Button
					type="submit"
					data-testid="save-timezone"
					disabled={savingZone}
					className="w-full"
				>
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
				<div className="space-y-2 border-t border-[var(--line)] pt-4">
					<p className="text-sm font-medium">Table Topics speaking limits</p>
					<p className="text-xs text-muted-foreground">
						{/* Rendered from the constant, not retyped: this used to be a
						    fourth hand-written copy of "1–2 minutes", so changing the
						    marks would have left the form promising the old window. */}
						Leave both blank to use the standard {TABLE_TOPICS_DEFAULT_TIMING}.
						Set them and your agenda, the projected deck and the Timer's colour
						marks and printed role sheet all switch to your club's own rule —
						the green light at the minimum, red at the maximum, and anything
						past the maximum disqualified.
					</p>
					{/* The shared `Input`, not a bare `<input>`. The hand-rolled pair
					    this replaces carried only `aria-invalid:border-destructive`, so
					    the invalid state was a 1px border where every neighbouring field
					    in this form shows a destructive RING — weakest in dark, where
					    `--line` is already nearly invisible. It also missed the shared
					    focus ring and used `text-sm`, which makes iOS Safari zoom the
					    page on focus. `Input` ships all three. */}
					{/* Explicit `htmlFor`/`id` rather than nesting the field inside the
					    label. Biome's `noLabelWithoutControl` cannot see through a
					    component boundary, so wrapping `<Input>` in a bare `<label>`
					    fails the gate — and the explicit pair is what every other field
					    in this form already does. */}
					<div className="flex gap-3">
						<div className="flex-1 space-y-1">
							<Label htmlFor="tt-min">Minimum</Label>
							<Input
								id="tt-min"
								type="text"
								inputMode="numeric"
								placeholder="1:00"
								value={ttMin}
								aria-invalid={ttRefusal?.field === "min"}
								aria-describedby={
									ttRefusal?.field === "min" ? "tt-min-error" : undefined
								}
								onChange={(e) => {
									setTtMin(e.target.value);
									clearTtRefusal("min");
								}}
							/>
							{ttRefusal?.field === "min" ? (
								<p id="tt-min-error" className="text-destructive text-xs">
									{ttRefusal.message}
								</p>
							) : null}
						</div>
						<div className="flex-1 space-y-1">
							<Label htmlFor="tt-max">Maximum</Label>
							<Input
								id="tt-max"
								type="text"
								inputMode="numeric"
								placeholder="2:30"
								value={ttMax}
								aria-invalid={ttRefusal?.field === "max"}
								aria-describedby={
									ttRefusal?.field === "max" ? "tt-max-error" : undefined
								}
								onChange={(e) => {
									setTtMax(e.target.value);
									clearTtRefusal("max");
								}}
							/>
							{ttRefusal?.field === "max" ? (
								<p id="tt-max-error" className="text-destructive text-xs">
									{ttRefusal.message}
								</p>
							) : null}
						</div>
					</div>
					<p className="text-xs text-muted-foreground">
						Minutes and seconds, like <code>2:30</code>, up to{" "}
						<code>{formatTableTopicsClock(MAX_TABLE_TOPICS_SECONDS)}</code>. Not{" "}
						<code>2.5</code> — a club that writes its cap as "2.3 min" means two
						minutes thirty, and a decimal here would store the wrong number.
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
						// Derived, not retyped: this filter is what the OS file picker
						// applies, so a hardcoded pair here is a fifth declaration of
						// the allow-list — user-visible, and invisible to the #504
						// guard, which sweeps identifiers and numbers rather than
						// attribute strings. `join()` rather than `join(",")`: comma is
						// its default, and a quote inside a JSX expression container
						// derails `club-logo-copy.guard.test.ts`'s string scan.
						accept={ALLOWED_LOGO_MIME_TYPES.join()}
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
