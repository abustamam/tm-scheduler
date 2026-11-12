// A member confirming ONE role they hold (#1612), shared by the meeting page's
// "Your jobs" card and the RSVP page. The holder arm of `confirmSlot` is
// selected by `memberId`; its server checks (archive gate, meeting lock, holder
// match) are the gate. Only the refetch differs between the two callers.
import { useRef, useState } from "react";
import { toast } from "sonner";
import { showWriteError } from "#/components/write-error-toast";
import { confirmSlot } from "#/server/slots";

export function useConfirmOwnRole(args: {
	memberId: string | null | undefined;
	refetch: () => Promise<unknown>;
}) {
	// A ref guards the tap itself (two clicks can land before React re-renders);
	// the state only drives `disabled`.
	const inFlight = useRef(false);
	const [confirming, setConfirming] = useState<string | null>(null);
	const { memberId, refetch } = args;

	async function confirm(slotId: string, roleName: string) {
		if (inFlight.current || !memberId) return;
		inFlight.current = true;
		setConfirming(slotId);
		try {
			await confirmSlot({ data: { slotId, memberId } });
			toast.success(`Confirmed as ${roleName}.`);
		} catch (err) {
			showWriteError(err, "Couldn't confirm that role.");
		} finally {
			// Released when the confirm settles, not when the refetch does.
			inFlight.current = false;
			setConfirming(null);
		}
		// Success or stale slot (released, reassigned, confirmed by an officer):
		// refetch either way so the button reflects the truth.
		await refetch().catch(() => undefined);
	}

	return { confirm, confirming };
}
