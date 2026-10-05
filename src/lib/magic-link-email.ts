import { escapeHtml } from "#/lib/html-escape";

// Single source of truth for the magic-link TTL: src/lib/auth.ts imports this
// for the magicLink `expiresIn`, and the email copy below derives its wording
// from it, so the displayed duration can never drift from the actual TTL.
export const MAGIC_LINK_EXPIRY_SECONDS = 60 * 5;
const EXPIRY_MINUTES = MAGIC_LINK_EXPIRY_SECONDS / 60;

export interface MagicLinkEmail {
	subject: string;
	html: string;
	text: string;
}

/** Build the magic-link sign-in email (subject + HTML + plaintext). */
export function buildMagicLinkEmail(url: string): MagicLinkEmail {
	const subject = "Your GavelUp sign-in link";

	const text = [
		"Sign in to GavelUp",
		"",
		"Click the link below to sign in. No password needed.",
		"",
		url,
		"",
		`This link expires in ${EXPIRY_MINUTES} minutes. If you didn't request it, you can safely ignore this email.`,
	].join("\n");

	const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
  </head>
  <body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:480px;margin:0 auto;padding:32px 24px;">
      <h1 style="font-size:20px;color:#18181b;margin:0 0 16px;">Sign in to GavelUp</h1>
      <p style="font-size:15px;line-height:1.5;color:#3f3f46;margin:0 0 24px;">
        Click the button below to sign in. No password needed.
      </p>
      <a href="${url}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 20px;border-radius:8px;">
        Sign in
      </a>
      <p style="font-size:13px;line-height:1.5;color:#71717a;margin:24px 0 0;">
        Or paste this link into your browser:<br />
        <a href="${url}" style="color:#3f3f46;word-break:break-all;">${url}</a>
      </p>
      <p style="font-size:13px;line-height:1.5;color:#a1a1aa;margin:24px 0 0;">
        This link expires in ${EXPIRY_MINUTES} minutes. If you didn't request it, you can safely ignore this email.
      </p>
    </div>
  </body>
</html>`;

	return { subject, html, text };
}

/**
 * Build the account-invite email (#266) — an admin invited this member to claim
 * their GavelUp account. Same secure magic link as the sign-in email; the copy
 * just frames it as an invitation and names the club when known. Escapes the
 * club name so it can't inject markup into the HTML body.
 */
export function buildInviteEmail(
	url: string,
	clubName?: string,
): MagicLinkEmail {
	const safeClub = clubName ? escapeHtml(clubName) : null;
	const clubPhraseHtml = safeClub ? ` for <strong>${safeClub}</strong>` : "";
	const clubPhraseText = clubName ? ` for ${clubName}` : "";
	const subject = safeClub
		? `You're invited to ${clubName} on GavelUp`
		: "You're invited to GavelUp";

	const text = [
		`Claim your GavelUp account${clubPhraseText}`,
		"",
		"An officer invited you to set up your account so your meeting roles and speech history follow you. No password needed — just click the link below.",
		"",
		url,
		"",
		`This link expires in ${EXPIRY_MINUTES} minutes. If you weren't expecting this, you can safely ignore this email.`,
	].join("\n");

	const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
  </head>
  <body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:480px;margin:0 auto;padding:32px 24px;">
      <h1 style="font-size:20px;color:#18181b;margin:0 0 16px;">Claim your GavelUp account</h1>
      <p style="font-size:15px;line-height:1.5;color:#3f3f46;margin:0 0 24px;">
        An officer invited you${clubPhraseHtml} to set up your account, so your meeting roles and speech history follow you. No password needed.
      </p>
      <a href="${url}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 20px;border-radius:8px;">
        Claim my account
      </a>
      <p style="font-size:13px;line-height:1.5;color:#71717a;margin:24px 0 0;">
        Or paste this link into your browser:<br />
        <a href="${url}" style="color:#3f3f46;word-break:break-all;">${url}</a>
      </p>
      <p style="font-size:13px;line-height:1.5;color:#a1a1aa;margin:24px 0 0;">
        This link expires in ${EXPIRY_MINUTES} minutes. If you weren't expecting this, you can safely ignore this email.
      </p>
    </div>
  </body>
</html>`;

	return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Changing a member's own sign-in address (#1091, ADR-0030). Three emails, all
// ADR-0028 class 1: account-security mail to the account's own address, sent
// because its holder just asked. None carries club content.
// ---------------------------------------------------------------------------

/** How long a change-of-address link lives: one hour (decision 7). */
export const CHANGE_EMAIL_LINK_EXPIRY_SECONDS = 60 * 60;

/** One shell for the three change emails, so their markup cannot drift. */
function changeEmailShell(heading: string, bodyHtml: string): string {
	return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
  </head>
  <body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:480px;margin:0 auto;padding:32px 24px;">
      <h1 style="font-size:20px;color:#18181b;margin:0 0 16px;">${heading}</h1>
${bodyHtml}
    </div>
  </body>
</html>`;
}

/**
 * Sent to the NEW address a member typed: the link that proves they control it.
 * The change happens only when it is clicked.
 */
export function buildChangeEmailVerificationEmail(
	url: string,
	newAddress: string,
): MagicLinkEmail {
	const subject = "Confirm your new GavelUp sign-in address";
	const text = [
		"Confirm your new GavelUp sign-in address",
		"",
		`Someone signed in to GavelUp asked to change their sign-in address to ${newAddress}. Click the link below to confirm. Nothing changes until you do.`,
		"",
		url,
		"",
		"This link expires in 1 hour. If you didn't ask for this, you can safely ignore this email.",
	].join("\n");
	const safeAddress = escapeHtml(newAddress);
	const html = changeEmailShell(
		"Confirm your new sign-in address",
		`      <p style="font-size:15px;line-height:1.5;color:#3f3f46;margin:0 0 24px;">
        Someone signed in to GavelUp asked to change their sign-in address to <strong>${safeAddress}</strong>. Nothing changes until you confirm.
      </p>
      <a href="${url}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 20px;border-radius:8px;">
        Confirm this address
      </a>
      <p style="font-size:13px;line-height:1.5;color:#71717a;margin:24px 0 0;">
        Or paste this link into your browser:<br />
        <a href="${url}" style="color:#3f3f46;word-break:break-all;">${url}</a>
      </p>
      <p style="font-size:13px;line-height:1.5;color:#a1a1aa;margin:24px 0 0;">
        This link expires in 1 hour. If you didn't ask for this, you can safely ignore this email.
      </p>`,
	);
	return { subject, html, text };
}

/**
 * Sent to the NEW address instead of a link when another account or another
 * member already carries it (decision 3). The requester's screen is the same
 * either way; only this inbox learns the real answer.
 */
export function buildAddressInUseEmail(newAddress: string): MagicLinkEmail {
	const subject = "This address is already in use on GavelUp";
	const sentence =
		"This address is already in use on GavelUp, so it can't be added to another account. Ask your club officer or GavelUp support to merge them.";
	const text = [
		"This address is already in use on GavelUp",
		"",
		`Someone signed in to GavelUp asked to change their sign-in address to ${newAddress}.`,
		"",
		sentence,
		"",
		"If you didn't ask for this, you can safely ignore this email.",
	].join("\n");
	const html = changeEmailShell(
		"This address is already in use",
		`      <p style="font-size:15px;line-height:1.5;color:#3f3f46;margin:0 0 16px;">
        Someone signed in to GavelUp asked to change their sign-in address to <strong>${escapeHtml(newAddress)}</strong>.
      </p>
      <p style="font-size:15px;line-height:1.5;color:#3f3f46;margin:0 0 16px;">${sentence}</p>
      <p style="font-size:13px;line-height:1.5;color:#a1a1aa;margin:24px 0 0;">
        If you didn't ask for this, you can safely ignore this email.
      </p>`,
	);
	return { subject, html, text };
}

/**
 * Sent to the OLD address once a change has been confirmed, and only then
 * (decision 1). The old inbox does not have to approve: the usual reason to
 * change is that it was lost.
 */
export function buildAddressChangedNoticeEmail(
	newAddress: string,
): MagicLinkEmail {
	const subject = "Your GavelUp sign-in address was changed";
	const sentence = `Your GavelUp sign-in address was changed to ${newAddress}. If this wasn't you, contact GavelUp support.`;
	const text = [
		"Your GavelUp sign-in address was changed",
		"",
		sentence,
		"",
		"You'll sign in with the new address from now on.",
	].join("\n");
	const html = changeEmailShell(
		"Your sign-in address was changed",
		`      <p style="font-size:15px;line-height:1.5;color:#3f3f46;margin:0 0 16px;">
        Your GavelUp sign-in address was changed to <strong>${escapeHtml(newAddress)}</strong>. If this wasn't you, contact GavelUp support.
      </p>
      <p style="font-size:13px;line-height:1.5;color:#71717a;margin:0;">
        You'll sign in with the new address from now on.
      </p>`,
	);
	return { subject, html, text };
}
