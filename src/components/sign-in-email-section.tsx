import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, Mail } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import {
	emailChangeOutcomeMessage,
	MEMBER_EMAIL_REQUEST_PATH,
} from "#/lib/member-email-change";
import { getSignInEmailState } from "#/server/account-email";

/**
 * "Sign-in email" on Account settings (#1091, ADR-0030): the address a member
 * signs in with, and a way to change it.
 *
 * Only an account bound to a Person gets the form (decision 6); the endpoint
 * refuses the rest itself. Submitting changes nothing: the NEW address gets a
 * link, and the change happens when it is clicked. The confirmation reads the
 * same whether that inbox got the link or an "already in use" email (decision
 * 3), so this screen cannot be used to learn who is on GavelUp.
 *
 * `outcome` is the `?emailChange=` a clicked link lands here with.
 */
export function SignInEmailSection({ outcome }: { outcome?: string }) {
	const state = useQuery({
		queryKey: ["sign-in-email"],
		queryFn: () => getSignInEmailState(),
	});
	const [newEmail, setNewEmail] = useState("");
	const [sentTo, setSentTo] = useState<string | null>(null);

	const request = useMutation({
		mutationFn: async (address: string) => {
			const { error } = await authClient.$fetch(MEMBER_EMAIL_REQUEST_PATH, {
				method: "POST",
				body: { newEmail: address },
			});
			if (error) {
				throw new Error(
					error.status === 429
						? "Too many requests, try again later."
						: (error.message ?? "Couldn't send the link."),
				);
			}
			return address;
		},
		onSuccess: (address) => {
			setSentTo(address.trim());
			setNewEmail("");
		},
	});

	const landed = emailChangeOutcomeMessage(outcome);

	return (
		<div className="space-y-3 rounded-xl border bg-card p-4">
			<div className="min-w-0">
				<h2 className="flex items-center gap-2 font-medium">
					<Mail className="size-4 text-primary" aria-hidden />
					Sign-in email
				</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					The address your sign-in links go to. Your clubs see it as your
					contact address.
				</p>
			</div>

			{landed ? (
				<output
					className={
						landed.tone === "success"
							? "block text-sm text-primary"
							: "block text-sm text-destructive"
					}
				>
					{landed.text}
				</output>
			) : null}

			{state.isLoading ? (
				<Loader2 className="size-4 animate-spin" />
			) : state.isError ? (
				<p className="text-sm text-destructive">
					Couldn't load your sign-in address.
				</p>
			) : (
				<>
					<p className="break-all text-sm font-medium">
						{state.data?.email ?? ""}
					</p>
					{state.data?.canChange ? (
						<form
							className="space-y-2"
							onSubmit={(e) => {
								e.preventDefault();
								if (newEmail.trim()) request.mutate(newEmail);
							}}
						>
							<Label htmlFor="new-sign-in-email">New address</Label>
							<div className="flex flex-col gap-2 sm:flex-row">
								<Input
									id="new-sign-in-email"
									type="email"
									autoComplete="email"
									value={newEmail}
									onChange={(e) => setNewEmail(e.target.value)}
									className="min-w-0 flex-1"
								/>
								<Button
									type="submit"
									disabled={request.isPending || !newEmail.trim()}
								>
									{request.isPending ? (
										<Loader2 className="size-4 animate-spin" />
									) : null}
									Send link
								</Button>
							</div>
							{sentTo ? (
								<output className="block text-sm text-muted-foreground">
									Check <span className="font-medium">{sentTo}</span> for a
									link. Your address changes when you click it, within the hour.
								</output>
							) : null}
							{request.isError ? (
								<p role="alert" className="text-sm text-destructive">
									{request.error.message}
								</p>
							) : null}
						</form>
					) : null}
				</>
			)}
		</div>
	);
}
