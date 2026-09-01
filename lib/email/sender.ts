import nodemailer from "nodemailer";
import Imap from "imap";

/** Replace all http(s) hrefs in HTML with click-tracking URLs. Skips mailto:, already-tracking links. */
function wrapLinks(html: string, baseUrl: string, targetId: string, runId: string, stepId: string): string {
  return html.replace(/href="(https?:\/\/[^"]+)"/gi, (match, url: string) => {
    // Skip if the URL is already a tracking link
    if (url.includes(`${baseUrl}/api/track/`)) return match;
    const trackUrl = `${baseUrl}/api/track/click?t=${encodeURIComponent(targetId)}&r=${encodeURIComponent(runId)}&s=${encodeURIComponent(stepId)}&u=${encodeURIComponent(url)}`;
    return `href="${trackUrl}"`;
  });
}

/** Append a 1x1 open-tracking pixel before closing </div> or at end of HTML. */
function addOpenPixel(html: string, baseUrl: string, targetId: string, runId: string, stepId: string): string {
  const pixel = `<img src="${baseUrl}/api/track/open?t=${encodeURIComponent(targetId)}&r=${encodeURIComponent(runId)}&s=${encodeURIComponent(stepId)}" width="1" height="1" style="display:none">`;
  const idx = html.lastIndexOf("</div>");
  if (idx !== -1) {
    return html.slice(0, idx) + pixel + html.slice(idx);
  }
  return html + pixel;
}

export interface EmailAccount {
  id: string;
  from_email: string;
  from_name: string | null;
  reply_to?: string | null;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: number; // 0 = STARTTLS, 1 = SSL
  username: string;
  password: string;
}

export async function sendEmail(
  account: EmailAccount,
  to: string,
  subject: string,
  body: string,
  htmlSignature?: string | null,
  trackingParams?: { targetId: string; runId: string; stepId: string; baseUrl: string },
): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: account.smtp_host,
    port: account.smtp_port,
    secure: account.smtp_secure === 1,
    auth: {
      user: account.username,
      pass: account.password,
    },
    // Allow self-signed certs (common in some corp SMTP setups)
    tls: { rejectUnauthorized: false },
  });

  const from = account.from_name
    ? `"${account.from_name}" <${account.from_email}>`
    : account.from_email;

  const hasHtmlSig = htmlSignature && /<[a-z][\s\S]*>/i.test(htmlSignature);

  let htmlBody: string | undefined;
  if (hasHtmlSig) {
    const bodyHtml = body
      .split("\n")
      .map((line) => line ? `<p style="margin:0 0 4px">${line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>` : `<br>`)
      .join("");
    htmlBody = `<div style="font-family:sans-serif;font-size:14px;color:#111">${bodyHtml}<br>${htmlSignature}</div>`;
  }

  if (htmlBody && trackingParams) {
    const { targetId, runId, stepId, baseUrl } = trackingParams;
    htmlBody = wrapLinks(htmlBody, baseUrl, targetId, runId, stepId);
    htmlBody = addOpenPixel(htmlBody, baseUrl, targetId, runId, stepId);
  }

  await transporter.sendMail({
    from, to, subject,
    text: body,
    ...(htmlBody ? { html: htmlBody } : {}),
    ...(account.reply_to ? { replyTo: account.reply_to } : {}),
  });
}

/**
 * Verifies SMTP connectivity — used by the test-connection endpoint.
 * Returns null on success, error message string on failure.
 */
export async function testSmtpConnection(account: Omit<EmailAccount, "id">): Promise<string | null> {
  try {
    const transporter = nodemailer.createTransport({
      host: account.smtp_host,
      port: account.smtp_port,
      secure: account.smtp_secure === 1,
      auth: { user: account.username, pass: account.password },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
    });
    await transporter.verify();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export interface ImapTestAccount {
  imap_host: string;
  imap_port: number;
  username: string;
  password: string;
  imap_username: string | null;
  imap_password: string | null;
}

/**
 * Verifies IMAP connectivity — connects, authenticates, then disconnects.
 * Returns null on success, error message string on failure.
 */
export async function testImapConnection(account: ImapTestAccount): Promise<string | null> {
  return new Promise((resolve) => {
    const imap = new Imap({
      host: account.imap_host,
      port: account.imap_port,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      user: account.imap_username ?? account.username,
      password: account.imap_password ?? account.password,
      authTimeout: 10_000,
      connTimeout: 12_000,
    });

    imap.once("ready", () => {
      try { imap.end(); } catch { /* ignore */ }
      resolve(null);
    });

    imap.once("error", (err: Error) => {
      resolve(err.message ?? String(err));
    });

    imap.connect();
  });
}
