const EXPIRY_MINUTES = 5;

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
