import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { type StoredMember, useCurrentMember } from "#/lib/member-identity";
import { PickNameForm } from "./pick-name-form";

interface IdentityGateValue {
	/** The effective identity: session member (shell) or the name-pick, else null. */
	member: StoredMember | null;
	/**
	 * The SIGNED-IN member of this club, when there is one — i.e. the reason
	 * `member` might not be the localStorage pick.
	 *
	 * Exposed for `?as=` seeding (#665), which must not write over the pick
	 * sitting underneath a session: the pick resurfaces on sign-out, and a
	 * caller cannot tell the two identities apart from `member` alone. Re-deriving
	 * it from route context at the call site would be a second copy of the
	 * shell's `effectiveMemberId && authCtx?.user` expression, which is the
	 * "component tested through its props cannot see a WRONG prop" trap in
	 * CLAUDE.md — one derivation, read from where it already lives.
	 */
	sessionMember: StoredMember | null;
	/** Resolve the current identity, or open the picker and resolve on pick.
	 *  Resolves `null` when the picker is dismissed (caller aborts). */
	requireIdentity: () => Promise<StoredMember | null>;
	/** Force-open the picker to switch identity (used by "not you?" / "I'm a
	 *  member"). Dismissal keeps the current identity. */
	promptIdentity: () => void;
}

const IdentityGateContext = createContext<IdentityGateValue | null>(null);

export function useRequireIdentity(): IdentityGateValue {
	const ctx = useContext(IdentityGateContext);
	if (!ctx) {
		throw new Error(
			"useRequireIdentity must be used within IdentityGateProvider",
		);
	}
	return ctx;
}

export function IdentityGateProvider({
	clubUuid,
	clubSlug,
	sessionMember,
	children,
}: {
	clubUuid: string;
	clubSlug: string;
	/** Signed-in member of this club (shell path) — takes precedence over the
	 *  name-pick and means the picker never needs to open. */
	sessionMember: StoredMember | null;
	children: React.ReactNode;
}) {
	const { member: picked, setMember } = useCurrentMember(clubSlug);
	const effective = sessionMember ?? picked;

	const [open, setOpen] = useState(false);
	// Pending requireIdentity() resolvers — single-flight: every call made while
	// the picker is open resolves together on the next pick/dismiss.
	const resolvers = useRef<((m: StoredMember | null) => void)[]>([]);

	const flush = useCallback((m: StoredMember | null) => {
		const pending = resolvers.current;
		resolvers.current = [];
		for (const r of pending) r(m);
	}, []);

	const requireIdentity = useCallback(() => {
		if (effective) return Promise.resolve(effective);
		return new Promise<StoredMember | null>((resolve) => {
			resolvers.current.push(resolve);
			setOpen(true);
		});
	}, [effective]);

	const promptIdentity = useCallback(() => setOpen(true), []);

	// If the provider unmounts while a caller is awaiting, don't leave the
	// promise hanging — resolve pending callers with null (abort).
	useEffect(() => () => flush(null), [flush]);

	const handlePicked = useCallback(
		(m: StoredMember) => {
			setMember(m);
			flush(m);
			setOpen(false);
		},
		[setMember, flush],
	);

	// Dialog closed WITHOUT a pick → resolve any pending callers with null
	// (abort). A switch (promptIdentity with an existing identity) simply keeps
	// the current identity because there were no pending resolvers.
	const handleOpenChange = useCallback(
		(next: boolean) => {
			setOpen(next);
			if (!next) flush(null);
		},
		[flush],
	);

	const value = useMemo(
		() => ({
			member: effective,
			sessionMember,
			requireIdentity,
			promptIdentity,
		}),
		[effective, sessionMember, requireIdentity, promptIdentity],
	);

	return (
		<IdentityGateContext.Provider value={value}>
			{children}
			<Dialog open={open} onOpenChange={handleOpenChange}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Who are you?</DialogTitle>
						<DialogDescription>
							Pick your name to continue. This just tags what you sign up for —
							no account needed.
						</DialogDescription>
					</DialogHeader>
					{open ? (
						<PickNameForm
							clubUuid={clubUuid}
							onPicked={handlePicked}
							// The club page is the surface with no other door, so it names
							// both of them (#616). Until this change the only forward path
							// for anyone not on the roster was an "I'm new — add me" box that
							// wrote a real membership row with no session, which is how a
							// tracked guest ended up in a club's roster.
							notListedHint={
								<>
									<p className="font-medium text-foreground">
										Don't see your name?
									</p>
									<p className="text-muted-foreground">
										Visiting us today?{" "}
										<a
											href={`/club/${clubSlug}/guest-book`}
											data-slot="guest-book-link"
											className="font-medium text-primary hover:underline"
										>
											Sign the guest book
										</a>{" "}
										and we'll say hello.
									</p>
									<p className="text-muted-foreground">
										Just joined the club? Ask an officer to add you to the
										roster.
									</p>
								</>
							}
						/>
					) : null}
				</DialogContent>
			</Dialog>
		</IdentityGateContext.Provider>
	);
}
