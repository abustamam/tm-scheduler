import { Check, Copy } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
	buildDistrictShareLink,
	districtShareBlurb,
	isValidDistrict,
} from "#/lib/district-share";

/**
 * "Share with your clubs" on `/districts` (#868): a message a district director
 * forwards to club presidents, ending in a link tagged `?ref=district-<d>`.
 *
 * `d` comes from the page URL (`/districts?d=57`) and prefills the input. One
 * that fails {@link isValidDistrict} is treated as absent: the raw value stays
 * in the input with the inline error showing, and no link is minted.
 *
 * The absolute link needs `window.location.origin`, which does not exist during
 * SSR. Until mount the block shows the relative path and the copy buttons are
 * disabled, so a relative link is never what lands on the clipboard. The
 * server render and the first client render agree, so there is no hydration
 * mismatch.
 *
 * The value is validated RAW, untrimmed: `?d=%2057%20` or a whitespace-only
 * entry is invalid, shows the error, and mints no link. The copy toasts render
 * in `MarketingShell`'s `<Toaster />`; this component mounts none of its own.
 */
export function DistrictShare({ d }: { d?: string }) {
	const [value, setValue] = useState(d ?? "");
	// Client-side navigation from ?d=57 to ?d=58 re-renders with a new prop
	// rather than remounting; without this the block keeps minting 57.
	useEffect(() => setValue(d ?? ""), [d]);
	const [origin, setOrigin] = useState<string | null>(null);
	useEffect(() => setOrigin(window.location.origin), []);

	const inputId = useId();
	const errorId = useId();
	const valid = isValidDistrict(value);
	// Only complain once there is something to complain about.
	const showError = value !== "" && !valid;

	const link = valid ? buildDistrictShareLink(origin ?? "", value) : null;
	const blurb = link ? districtShareBlurb(link) : null;

	return (
		<div className="space-y-5">
			<div className="max-w-xs space-y-2">
				<Label htmlFor={inputId}>Your district number</Label>
				<Input
					id={inputId}
					value={value}
					onChange={(e) => setValue(e.target.value)}
					inputMode="text"
					autoComplete="off"
					maxLength={16}
					placeholder="e.g. 57"
					aria-invalid={showError || undefined}
					aria-describedby={showError ? errorId : undefined}
				/>
				{showError ? (
					<p id={errorId} className="text-sm text-destructive">
						Enter your district's number: up to 4 letters or digits, like 57.
					</p>
				) : null}
			</div>

			{link && blurb ? (
				<div className="space-y-4" data-testid="district-share-output">
					<div className="rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] p-5">
						<p className="text-base leading-relaxed" data-testid="share-blurb">
							{blurb}
						</p>
						<div className="mt-4">
							<CopyButton
								text={blurb}
								label="Copy message"
								disabled={origin === null}
							/>
						</div>
					</div>
					<div className="flex flex-wrap items-center gap-3">
						<code
							className="break-all rounded-md bg-[var(--surface-strong)] px-2 py-1 text-sm"
							data-testid="share-link"
						>
							{link}
						</code>
						<CopyButton
							text={link}
							label="Copy link"
							disabled={origin === null}
						/>
					</div>
				</div>
			) : null}
		</div>
	);
}

function CopyButton({
	text,
	label,
	disabled,
}: {
	text: string;
	label: string;
	disabled: boolean;
}) {
	const [copied, setCopied] = useState(false);

	async function copy() {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			toast.success("Copied. Paste it to your club presidents.");
			setTimeout(() => setCopied(false), 2000);
		} catch {
			toast.error(
				"Couldn't copy: your browser blocked clipboard access. Select the text and copy it by hand.",
			);
		}
	}

	return (
		<Button
			type="button"
			variant="outline"
			size="sm"
			onClick={copy}
			disabled={disabled}
		>
			{copied ? (
				<Check className="size-4" aria-hidden />
			) : (
				<Copy className="size-4" aria-hidden />
			)}
			{label}
		</Button>
	);
}
