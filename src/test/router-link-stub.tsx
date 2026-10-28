import type * as React from "react";

// Router-only props a real <Link> consumes; they must not reach the <a>.
type LinkStubProps = {
	to: string;
	params?: Record<string, string>;
	search?: unknown;
	hash?: unknown;
	preload?: unknown;
	activeProps?: unknown;
	inactiveProps?: unknown;
	activeOptions?: unknown;
	resetScroll?: unknown;
	replace?: unknown;
	children?: React.ReactNode;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "children">;

/** A stand-in <Link> for suites that render without a router. Substitutes
 * `params` into `to` for the href and drops the router-only props. */
export function RouterLinkStub({
	to,
	params,
	search: _search,
	hash: _hash,
	preload: _preload,
	activeProps: _activeProps,
	inactiveProps: _inactiveProps,
	activeOptions: _activeOptions,
	resetScroll: _resetScroll,
	replace: _replace,
	children,
	...rest
}: LinkStubProps) {
	return (
		<a
			{...rest}
			href={to.replace(/\$(\w+)/g, (_, k: string) => params?.[k] ?? "")}
		>
			{children}
		</a>
	);
}

/** Use as: vi.mock("@tanstack/react-router", async (importOriginal) =>
 * (await import("#/test/router-link-stub")).routerLinkMock(await importOriginal())) */
export function routerLinkMock<T extends object>(actual: T) {
	return { ...actual, Link: RouterLinkStub };
}
