import {
	createContext,
	useCallback,
	useContext,
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
		() => ({ member: effective, requireIdentity, promptIdentity }),
		[effective, requireIdentity, promptIdentity],
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
						<PickNameForm clubUuid={clubUuid} onPicked={handlePicked} />
					) : null}
				</DialogContent>
			</Dialog>
		</IdentityGateContext.Provider>
	);
}
