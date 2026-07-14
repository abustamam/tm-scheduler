import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

const STORAGE_KEY = "gavelup-theme";

/**
 * Light/dark toggle for the workspace top bar and the public club shell.
 * Flips the `dark` class on the document root (all tokens cascade from there)
 * and persists the choice. The initial class is applied pre-paint by a script
 * in `__root.tsx`; here we read the live state after mount to keep SSR markup
 * stable. `compact` renders an icon-only square button (sized to match the
 * public header's 30px brand chip) for tight headers.
 */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
	const [isDark, setIsDark] = useState(false);
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		setIsDark(document.documentElement.classList.contains("dark"));
		setMounted(true);
	}, []);

	function toggle() {
		const next = !isDark;
		setIsDark(next);
		document.documentElement.classList.toggle("dark", next);
		try {
			localStorage.setItem(STORAGE_KEY, next ? "dark" : "light");
		} catch {
			// localStorage unavailable (private mode / SSR) — ignore.
		}
	}

	if (compact) {
		return (
			<button
				type="button"
				onClick={toggle}
				title="Toggle theme"
				aria-label="Toggle theme"
				className="flex size-[30px] shrink-0 items-center justify-center rounded-[9px] border border-[var(--line)] bg-[var(--surface-strong)] text-[var(--sea-ink)] transition-colors hover:bg-[var(--foam)]"
			>
				{isDark ? (
					<Sun className="size-4" aria-hidden />
				) : (
					<Moon className="size-4" aria-hidden />
				)}
			</button>
		);
	}

	return (
		<button
			type="button"
			onClick={toggle}
			title="Toggle theme"
			className="flex items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-2 text-xs font-semibold text-[var(--sea-ink)] transition-colors hover:bg-[var(--foam)]"
		>
			{isDark ? (
				<Sun className="size-4" aria-hidden />
			) : (
				<Moon className="size-4" aria-hidden />
			)}
			{/* Render the label only after mount so server and client agree. */}
			<span suppressHydrationWarning>
				{mounted ? (isDark ? "Light" : "Dark") : ""}
			</span>
		</button>
	);
}
