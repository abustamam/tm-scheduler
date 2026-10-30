import { useNavigate } from "@tanstack/react-router";
import {
	useCallback,
	useEffect,
	useEffectEvent,
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
import { isTypingTarget } from "#/lib/keyboard";
import { type NavGrants, navDestination } from "#/lib/nav-destinations";
import {
	activeShortcuts,
	HELP_KEYS,
	isPresentRoute,
	type Shortcut,
	searchModifier,
} from "#/lib/shortcuts";

/** How long `g` waits for its second key. */
export const SEQUENCE_WINDOW_MS = 1000;

const DIALOG_OPEN = '[role="dialog"][data-state="open"]';

function KeyChips({ keys, sep = "then" }: { keys: string; sep?: string }) {
	const parts = keys.split(" ");
	return (
		<span className="flex items-center gap-1">
			{parts.map((k, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a fixed, static key list
				<span key={i} className="flex items-center gap-1">
					{i > 0 ? (
						<span className="text-xs text-muted-foreground">{sep}</span>
					) : null}
					<kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">
						{k}
					</kbd>
				</span>
			))}
		</span>
	);
}

/**
 * Global officer shortcuts and the `?` sheet (#1426). Mounted once in
 * `AppShell`. Desktop only (a coarse pointer has no keyboard to speak of), and
 * silent while typing, with a modifier held, with a dialog open, or on the
 * present route, whose own listener owns the keyboard.
 */
export function KeyboardShortcuts({
	grants,
	pathname,
}: {
	grants: NavGrants;
	pathname: string;
}) {
	const navigate = useNavigate();
	const [helpOpen, setHelpOpen] = useState(false);
	const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

	const watcher = useRef<MutationObserver | null>(null);

	const clearPending = useCallback(() => {
		if (pending.current) clearTimeout(pending.current);
		pending.current = null;
		watcher.current?.disconnect();
		watcher.current = null;
	}, []);

	const onKeyDown = useEffectEvent((e: KeyboardEvent) => {
		if (e.defaultPrevented || e.isComposing || e.repeat) return;
		// Pressing Shift on the way to `?` completes nothing and cancels nothing.
		if (e.key === "Shift") return;
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		if (isTypingTarget(e.target)) return;
		if (window.matchMedia?.("(pointer: coarse)").matches) return;
		if (isPresentRoute(pathname)) return;
		if (document.querySelector(DIALOG_OPEN)) {
			clearPending();
			return;
		}

		const active = activeShortcuts(grants);
		const run = (s: Shortcut) => {
			e.preventDefault();
			if (s.keys === HELP_KEYS) setHelpOpen(true);
			else if (s.to) void navigate({ to: navDestination(s.to).to });
		};

		if (pending.current) {
			clearPending();
			const done = active.find((s) => s.keys === `g ${e.key}`);
			if (done) return run(done);
			// Completes nothing: the sequence is cancelled and the key is read afresh.
		}
		const single = active.find((s) => s.keys === e.key);
		if (single) return run(single);
		if (e.key === "g" && active.some((s) => s.keys.startsWith("g "))) {
			pending.current = setTimeout(clearPending, SEQUENCE_WINDOW_MS);
			// A dialog opening by mouse and closing again fires no key while it is
			// open, so watch for it: opening one cancels the sequence.
			watcher.current = new MutationObserver(() => {
				if (document.querySelector(DIALOG_OPEN)) clearPending();
			});
			watcher.current.observe(document.body, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ["data-state"],
			});
		}
	});

	useEffect(() => {
		const onFocusIn = (e: FocusEvent) => {
			if (isTypingTarget(e.target)) clearPending();
		};
		window.addEventListener("keydown", onKeyDown);
		document.addEventListener("focusin", onFocusIn);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			document.removeEventListener("focusin", onFocusIn);
			clearPending();
		};
	}, [clearPending]);

	const modifier = searchModifier(
		typeof navigator === "undefined" ? {} : navigator,
	);
	const active = activeShortcuts(grants);
	const groups = (["Go to", "Actions"] as const).map((name) => ({
		name,
		items: active.filter((s) => s.group === name),
	}));

	return (
		<Dialog open={helpOpen} onOpenChange={setHelpOpen}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Keyboard shortcuts</DialogTitle>
					<DialogDescription>
						Press a key outside a text field. Sequences wait one second for the
						second key.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					{groups.map((g) =>
						g.items.length === 0 ? null : (
							<section key={g.name}>
								<h3 className="mb-1 text-sm font-semibold">{g.name}</h3>
								<ul className="space-y-1">
									{g.items.map((s) => (
										<li
											key={s.keys}
											className="flex items-center justify-between gap-4 text-sm"
										>
											<span>{s.label}</span>
											<KeyChips keys={s.keys} />
										</li>
									))}
									{g.name === "Actions" ? (
										<>
											<li className="flex items-center justify-between gap-4 text-sm">
												<span>Search</span>
												<KeyChips keys="/" />
											</li>
											<li className="flex items-center justify-between gap-4 text-sm">
												<span>Search</span>
												<KeyChips keys={`${modifier} K`} sep="+" />
											</li>
										</>
									) : null}
								</ul>
							</section>
						),
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
