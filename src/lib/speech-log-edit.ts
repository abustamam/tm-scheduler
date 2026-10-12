// Whether the speech log shows its edit button (#1159). A PREDICTION only: the
// server (`applySpeechLogEdit`) is the gate, and refuses anyone this lets
// through by mistake. It is shown to an admin or officer of the club (the
// caller's `viewerIsAdmin`) and to the speaker themselves.

export function mayShowSpeechLogEdit(args: {
	viewerIsAdmin: boolean;
	viewerUserId: string | null;
	/** The speaker's linked account, null for a roster row with none. */
	memberUserId: string | null;
}): boolean {
	return (
		args.viewerIsAdmin ||
		(args.viewerUserId !== null && args.viewerUserId === args.memberUserId)
	);
}
