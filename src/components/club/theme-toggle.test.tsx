// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ThemeToggle } from "./theme-toggle";

const STORAGE_KEY = "gavelup-theme";

describe("ThemeToggle", () => {
	afterEach(() => {
		cleanup();
		localStorage.clear();
		document.documentElement.classList.remove("dark");
	});

	it("offers 'Dark' in light mode and flips root class + storage on click", async () => {
		render(<ThemeToggle />);
		const button = screen.getByTitle("Toggle theme");
		expect(await screen.findByText("Dark")).toBeTruthy();

		await userEvent.click(button);

		expect(document.documentElement.classList.contains("dark")).toBe(true);
		expect(localStorage.getItem(STORAGE_KEY)).toBe("dark");
		expect(screen.getByText("Light")).toBeTruthy();
	});

	it("reads a pre-applied dark class on mount (pre-paint script contract)", async () => {
		// __root.tsx's inline script adds `.dark` before React hydrates; the
		// toggle must pick that up instead of assuming light.
		document.documentElement.classList.add("dark");
		render(<ThemeToggle />);
		expect(await screen.findByText("Light")).toBeTruthy();

		await userEvent.click(screen.getByTitle("Toggle theme"));

		expect(document.documentElement.classList.contains("dark")).toBe(false);
		expect(localStorage.getItem(STORAGE_KEY)).toBe("light");
	});

	it("compact variant is icon-only but keeps an accessible name", async () => {
		render(<ThemeToggle compact />);
		const button = screen.getByRole("button", { name: "Toggle theme" });
		// No visible Dark/Light label in the compact footprint.
		expect(screen.queryByText("Dark")).toBeNull();
		expect(screen.queryByText("Light")).toBeNull();

		await userEvent.click(button);

		expect(document.documentElement.classList.contains("dark")).toBe(true);
		expect(localStorage.getItem(STORAGE_KEY)).toBe("dark");
	});

	it("compact and full variants share the same storage key", async () => {
		render(<ThemeToggle compact />);
		await userEvent.click(screen.getByRole("button", { name: "Toggle theme" }));
		expect(localStorage.getItem(STORAGE_KEY)).toBe("dark");
		cleanup();

		// The authed shell's full toggle sees the same dark state.
		render(<ThemeToggle />);
		expect(await screen.findByText("Light")).toBeTruthy();
	});
});
