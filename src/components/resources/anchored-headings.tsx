import { Children, type ComponentPropsWithoutRef, type ReactNode } from "react";
import type { Components } from "react-markdown";
import { slugifyHeading, splitHeadingId } from "#/lib/heading-anchor";

/** Plain text of a heading's children, for the derived slug. */
function textOf(children: ReactNode): string {
	return Children.toArray(children)
		.map((child) =>
			typeof child === "string" || typeof child === "number"
				? String(child)
				: typeof child === "object" && child && "props" in child
					? textOf((child.props as { children?: ReactNode }).children)
					: "",
		)
		.join("");
}

/**
 * Strip a trailing `{#id}` off the LAST text child and return it as the id.
 * react-markdown hands a heading's inline content over as an array, and the
 * marker is always at the end of the source line, so only the last child can
 * carry it.
 */
function withAnchor(children: ReactNode): {
	children: ReactNode;
	id: string;
} {
	const parts = Children.toArray(children);
	const last = parts[parts.length - 1];
	if (typeof last === "string") {
		const split = splitHeadingId(last);
		if (split.id) {
			return { children: [...parts.slice(0, -1), split.text], id: split.id };
		}
	}
	return { children, id: slugifyHeading(textOf(children)) };
}

/**
 * The signed-in shell pins a top bar (`sticky top-0`, taller still while
 * impersonating), so a jump to `#base-camp` would otherwise park the heading
 * underneath it.
 */
const ANCHOR_OFFSET = "scroll-mt-24";

function anchorClass(className: string | undefined): string {
	return className ? `${className} ${ANCHOR_OFFSET}` : ANCHOR_OFFSET;
}

type HeadingProps = ComponentPropsWithoutRef<"h2"> & { node?: unknown };

/** One component per heading level; they differ only in the tag. */
function anchoredHeading(Tag: "h2" | "h3") {
	function AnchoredHeading({
		node: _node,
		children,
		className,
		...rest
	}: HeadingProps) {
		const anchored = withAnchor(children);
		return (
			<Tag
				{...rest}
				id={anchored.id || undefined}
				className={anchorClass(className)}
			>
				{anchored.children}
			</Tag>
		);
	}
	AnchoredHeading.displayName = `Anchored(${Tag})`;
	return AnchoredHeading;
}

/** Pass to `<ReactMarkdown components={…}>` on a resource article. */
export const anchoredHeadingComponents: Components = {
	h2: anchoredHeading("h2"),
	h3: anchoredHeading("h3"),
};
