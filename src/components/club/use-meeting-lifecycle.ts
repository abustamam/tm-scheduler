import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { showWriteError } from "#/components/write-error-toast";
import {
	cancellationNoticeHref,
	MEETING_ALREADY_CANCELLED_MESSAGE,
} from "#/lib/meeting-cancellation-notice";
import {
	applyTemplateToMeeting,
	listTemplatesForClub,
	type MeetingTemplateSummary,
	previewTemplateForMeeting,
} from "#/server/meeting-templates";
import {
	cancelMeeting,
	completeMeeting,
	reopenMeeting,
	restoreMeeting,
} from "#/server/meetings";
import { addRoleSlot } from "#/server/slots";
import type { LifecycleAction } from "./meeting-toolbar";

/**
 * The meeting page's lifecycle domain (#1476): add a role, complete, reopen,
 * cancel and restore, plus the meeting-setup dialogs the Manage menu opens
 * (word of the day, meeting details, meeting type) and the cancel notice sheet.
 */
export function useMeetingLifecycle(args: {
	meetingId: string;
	/** The club's uuid, for the meeting-type list. */
	meetingClubId: string;
	/** The club key in the URL (`clubId` route param). */
	clubKey: string;
	/** The key the URL actually carries (a club-local date or the uuid). */
	meetingKeyParam: string;
	/** The server's canonical key, which every link on the page uses. */
	urlKey: string;
	/** `?notice=1` on the URL (#1057). */
	noticeRequested: boolean;
	cancelled: boolean;
	effectiveCanManage: boolean;
}) {
	const {
		meetingId,
		meetingClubId,
		clubKey,
		meetingKeyParam,
		urlKey,
		noticeRequested,
		cancelled,
		effectiveCanManage,
	} = args;
	const router = useRouter();

	const [addRoleOpen, setAddRoleOpen] = useState(false);
	const [addRoleBusy, setAddRoleBusy] = useState(false);
	// WHICH lifecycle write is in flight (#1057). Every lifecycle control
	// disables while any one runs, but only the one pressed spins and carries
	// `aria-busy` — Complete and Cancel used to share a single spinner.
	const [lifecycleAction, setLifecycleAction] =
		useState<LifecycleAction | null>(null);
	const lifecycleBusy = lifecycleAction !== null;
	// Cancel (#1057): the confirm before the write, and the notice sheet after
	// it. Two flags because the sheet outlives the confirm — it opens on arrival
	// too, when the URL carries `?notice=1` (see `doCancel`).
	const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
	const [noticeOpen, setNoticeOpen] = useState(false);
	// The meeting-setup dialogs the Manage menu and the Toastmaster's / Grammarian's
	// buttons open (they lived on the agenda until the toolbar took the entries).
	// "Change meeting type" loads its template list lazily, on open: an officer
	// affordance nobody else pays for.
	const [wodOpen, setWodOpen] = useState(false);
	const [metaOpen, setMetaOpen] = useState(false);
	const [templateOpen, setTemplateOpen] = useState(false);
	const [templates, setTemplates] = useState<MeetingTemplateSummary[]>([]);

	// Arriving with `?notice=1` (#1057): `doCancel` moves a bare-date URL to the
	// uuid URL after the write, and this is how the sheet opens on the far side.
	// Officers only, on a meeting that is actually cancelled — a stale link on
	// a restored meeting opens nothing.
	useEffect(() => {
		if (noticeRequested && cancelled && effectiveCanManage) {
			setNoticeOpen(true);
		}
	}, [noticeRequested, cancelled, effectiveCanManage]);

	async function doAddRole(roleDefinitionId: string) {
		setAddRoleBusy(true);
		try {
			await addRoleSlot({ data: { meetingId, roleDefinitionId } });
			toast.success("Role added.");
			setAddRoleOpen(false);
			await router.invalidate();
		} catch (err) {
			showWriteError(err, "Something went wrong.");
		} finally {
			setAddRoleBusy(false);
		}
	}

	async function doComplete() {
		setLifecycleAction("complete");
		try {
			await completeMeeting({ data: { meetingId } });
			toast.success("Meeting closed out and locked.");
			await router.invalidate();
		} catch (err) {
			showWriteError(err, "Something went wrong.");
		} finally {
			setLifecycleAction(null);
		}
	}

	async function doReopen() {
		setLifecycleAction("reopen");
		try {
			await reopenMeeting({ data: { meetingId } });
			toast.success("Meeting reopened for edits.");
			await router.invalidate();
		} catch (err) {
			showWriteError(err, "Something went wrong.");
		} finally {
			setLifecycleAction(null);
		}
	}

	// Cancel (#1057), after the confirm. The officer stays on the page and the
	// notice opens — by the uuid URL, because a bare-date key skips a cancelled
	// meeting (`meeting-resolve-logic.ts`) and `router.invalidate()` on a date
	// URL would 404 the page the officer is looking at. `replace`, so Back does
	// not land on that dead date URL. Same-URL case: the loader is re-run and
	// the sheet opens in place.
	//
	// "Already cancelled" is the SUCCESS path with a different sentence: another
	// officer (or this one, in another tab) got there first, the meeting is in
	// exactly the state that was asked for, and the officer still needs the
	// notice. Compared by identity with the constant, never by substring.
	async function doCancel() {
		setLifecycleAction("cancel");
		try {
			let alreadyCancelled = false;
			try {
				await cancelMeeting({ data: { meetingId } });
			} catch (err) {
				if (
					!(err instanceof Error) ||
					err.message !== MEETING_ALREADY_CANCELLED_MESSAGE
				) {
					throw err;
				}
				alreadyCancelled = true;
			}
			setCancelConfirmOpen(false);
			toast.success(
				alreadyCancelled
					? "This meeting was already cancelled. Nothing has been sent."
					: "Meeting cancelled. Nothing has been sent.",
			);
			if (meetingKeyParam !== urlKey) {
				await router.navigate({
					href: cancellationNoticeHref(clubKey, urlKey),
					replace: true,
				});
			} else {
				await router.invalidate();
				setNoticeOpen(true);
			}
		} catch (err) {
			showWriteError(err, "Something went wrong.");
		} finally {
			setLifecycleAction(null);
		}
	}

	async function doRestore() {
		setLifecycleAction("restore");
		try {
			await restoreMeeting({ data: { meetingId } });
			toast.success("Meeting restored. Everyone still has their role.");
			await router.invalidate();
		} catch (err) {
			showWriteError(err, "Something went wrong.");
		} finally {
			setLifecycleAction(null);
		}
	}

	// "Change meeting type" (the toolbar entry). A failed fetch must not open the
	// dialog onto an empty or stale list, and must not be an unhandled rejection
	// with no feedback: it surfaces the way this page surfaces every failed write.
	async function openTemplateDialog() {
		try {
			setTemplates(
				await listTemplatesForClub({
					data: { clubId: meetingClubId },
				}),
			);
			setTemplateOpen(true);
		} catch (err) {
			showWriteError(err, "Couldn't load the meeting types.");
		}
	}

	function loadTemplatePreview(templateId: string | null) {
		return previewTemplateForMeeting({
			data: { meetingId, templateId },
		});
	}

	async function applyTemplate(templateId: string | null) {
		await applyTemplateToMeeting({
			data: { meetingId, templateId },
		});
		// Re-runs the meeting loader, so the agenda re-renders in the meeting's
		// new shape.
		await router.invalidate();
	}

	async function onWodSaved() {
		setWodOpen(false);
		await router.invalidate();
	}

	async function onMetaSaved() {
		setMetaOpen(false);
		await router.invalidate();
	}

	return {
		addRoleOpen,
		setAddRoleOpen,
		addRoleBusy,
		lifecycleAction,
		lifecycleBusy,
		cancelConfirmOpen,
		setCancelConfirmOpen,
		noticeOpen,
		setNoticeOpen,
		wodOpen,
		setWodOpen,
		metaOpen,
		setMetaOpen,
		templateOpen,
		setTemplateOpen,
		templates,
		doAddRole,
		doComplete,
		doReopen,
		doCancel,
		doRestore,
		openTemplateDialog,
		loadTemplatePreview,
		applyTemplate,
		onWodSaved,
		onMetaSaved,
	};
}
