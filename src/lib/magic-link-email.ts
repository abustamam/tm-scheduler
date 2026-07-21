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

/** Minimal HTML-entity escape for interpolating untrusted text into the email
 *  body (the club name is admin-controlled but still worth escaping). */
function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
