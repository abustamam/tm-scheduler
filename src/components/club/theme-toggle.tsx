import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

const STORAGE_KEY = "gavelup-theme";

/**
 * Light/dark toggle for the workspace top bar. Flips the `dark` class on the
 * document root (all tokens cascade from there) and persists the choice. The
 * initial class is applied pre-paint by a script in `__root.tsx`; here we read
 * the live state after mount to keep SSR markup stable.
 */
export function ThemeToggle() {
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

	return (
		<button
			type="button"
			onClick={toggle}
			title="Toggle theme"
			className="flex items-center gap-[7px] rounded-[10px] border border-[var(--line)] bg-[var(--surface-strong)] px-[13px] py-2 text-[12.5px] font-semibold text-[var(--sea-ink)] transition-colors hover:bg-[var(--foam)]"
		>
			{isDark ? (
				<Sun className="size-[15px]" aria-hidden />
			) : (
				<Moon className="size-[15px]" aria-hidden />
			)}
			{/* Render the label only after mount so server and client agree. */}
			<span suppressHydrationWarning>
				{mounted ? (isDark ? "Light" : "Dark") : ""}
			</span>
		</button>
	);
}
