import { createFileRoute } from "@tanstack/react-router";
import { ApiTokensSection } from "#/components/api-tokens-section";
import { ConnectedAppsSection } from "#/components/connected-apps-section";
import { PageContainer } from "#/components/page-container";
import { PreferredContactSection } from "#/components/preferred-contact-section";
import { SignInEmailSection } from "#/components/sign-in-email-section";
import { navLabel } from "#/lib/nav-destinations";

/**
 * Account settings (#912): the controls that belong to the signed-in PERSON
 * rather than to their meeting jobs. They lived on `/me` ("My roles") until
 * then, which is where a member looks for what they're doing next week — not
 * where anyone expects to mint a credential or cut off an app.
 *
 * There is no reminder-email toggle: GavelUp sends no reminders (ADR-0028,
 * #902), so there is nothing to opt out of.
 */
export const Route = createFileRoute("/_authed/account")({
	// `?emailChange=` is where a clicked change-of-address link lands (#1091).
	validateSearch: (
		search: Record<string, unknown>,
	): { emailChange?: string } =>
		typeof search.emailChange === "string"
			? { emailChange: search.emailChange }
			: {},
	component: AccountSettings,
});

function AccountSettings() {
	const { emailChange } = Route.useSearch();
	return (
		<PageContainer className="space-y-4">
			<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
				{navLabel("/account")}
			</h1>

			{/* Every signed-in account sees its address; only one bound to a
			    club member gets the change form (#1091, ADR-0030). */}
			<SignInEmailSection outcome={emailChange} />

			{/* How officers should reach this member (#1093). Renders nothing
			    for an account with no club member behind it. */}
			<PreferredContactSection />

			{/* Renders nothing unless the user is an admin or officer somewhere
			    (#773). That check is server-side — see `ApiTokensSection`. */}
			<ApiTokensSection />

			{/* Shown to everyone signed in (#851): removing an app is not a
			    privilege, it is the only way to cut one off. */}
			<ConnectedAppsSection />
		</PageContainer>
	);
}
