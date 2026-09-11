import nodemailer from "nodemailer";
import Imap from "imap";

export interface EmailAccount {
  id: string;
  from_email: string;
  from_name: string | null;
  reply_to?: string | null;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: number; // 0 = STARTTLS, 1 = SSL
  username: string;
  password: string; // decrypted
  // IMAP / save-to-sent
  imap_host?: string | null;
  imap_port?: number | null;
  imap_username?: string | null;
  imap_password?: string | null; // decrypted
  save_to_sent?: number | null; // 1 = enabled
}

export async function sendEmail(
  account: EmailAccount,
  to: string,
  subject: string,
  body: string,
  htmlSignature?: string | null,
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

  const bodyHtml = body
    .split("\n")
    .map((line) => line ? `<p style="margin:0 0 4px">${line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>` : `<br>`)
    .join("");
  const htmlBody = `<div style="font-family:sans-serif;font-size:14px;color:#111">${bodyHtml}${hasHtmlSig ? `<br>${htmlSignature}` : ""}</div>`;

  await transporter.sendMail({
    from, to, subject,
    text: body,
    html: htmlBody,
    ...(account.reply_to ? { replyTo: account.reply_to } : {}),
  });

  // Fire-and-forget IMAP append; never lets failure surface as a send error
  appendToSentFolder(account, to, subject, body, htmlBody).catch((err) =>
    console.warn("[sender] appendToSentFolder failed:", err instanceof Error ? err.message : err)
  );
}

function buildRawMessage(from: string, to: string, subject: string, text: string, html: string): Buffer {
  const date = new Date().toUTCString();
  const boundary = `----=_Part_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const lines = [
    `Date: ${date}`,
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    text,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset=utf-8`,
    ``,
    html,
    ``,
    `--${boundary}--`,
  ];
  return Buffer.from(lines.join("\r\n"), "utf-8");
}

/**
 * Appends the sent message to the IMAP Sent folder.
 * Skips silently for Gmail (they auto-save via SMTP).
 * Tries common Sent folder names in order.
 */
export async function appendToSentFolder(
  account: EmailAccount,
  to: string,
  subject: string,
  text: string,
  html: string,
): Promise<void> {
  if (!account.save_to_sent) return;
  if (!account.imap_host) return;
  // Gmail auto-saves sent mail — appending would create duplicates
  if (account.smtp_host.includes("smtp.gmail.com")) return;

  const from = account.from_name
    ? `"${account.from_name}" <${account.from_email}>`
    : account.from_email;
  const raw = buildRawMessage(from, to, subject, text, html);

  const SENT_FOLDERS = ["Sent", "Sent Items", "Sent Messages", "INBOX.Sent", "[Gmail]/Sent Mail"];

  return new Promise((resolve) => {
    const imap = new Imap({
      host: account.imap_host!,
      port: account.imap_port ?? 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      user: account.imap_username ?? account.username,
      password: account.imap_password ?? account.password,
      authTimeout: 10_000,
      connTimeout: 12_000,
    });

    imap.once("ready", () => {
      let idx = 0;
      function tryNext() {
        if (idx >= SENT_FOLDERS.length) {
          try { imap.end(); } catch { /* ignore */ }
          console.warn("[sender] appendToSentFolder: no matching Sent folder found");
          resolve(); // don't reject — send already succeeded
          return;
        }
        const folder = SENT_FOLDERS[idx++];
        imap.append(raw, { mailbox: folder, flags: ["\\Seen"], date: new Date() }, (err) => {
          if (err) {
            tryNext();
          } else {
            try { imap.end(); } catch { /* ignore */ }
            resolve();
          }
        });
      }
      tryNext();
    });

    imap.once("error", () => {
      resolve(); // IMAP failure must not surface as a send error
    });

    imap.connect();
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
