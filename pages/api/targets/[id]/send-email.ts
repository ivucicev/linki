import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { sendEmail } from "@/lib/email/sender";
import { decryptSecret } from "@/lib/crypto";
import { randomUUID } from "crypto";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const db = getDb();
  const targetId = req.query.id as string;
  const { email_account_id, subject, body } = req.body as {
    email_account_id: string;
    subject: string;
    body: string;
  };

  if (!email_account_id || !subject?.trim() || !body?.trim()) {
    return res.status(400).json({ error: "email_account_id, subject, body required" });
  }

  const target = db.prepare("SELECT id, full_name, email FROM targets WHERE id = ?").get(targetId) as
    { id: string; full_name: string | null; email: string | null } | undefined;
  if (!target) return res.status(404).json({ error: "Target not found" });
  if (!target.email) return res.status(400).json({ error: "Contact has no email address" });

  const account = db.prepare("SELECT * FROM email_accounts WHERE id = ? AND is_verified = 1").get(email_account_id) as {
    id: string; from_email: string; from_name: string | null; reply_to: string | null;
    smtp_host: string; smtp_port: number; smtp_secure: number;
    username: string; password: string;
    imap_host: string | null; imap_port: number; imap_username: string | null; imap_password: string | null;
    save_to_sent: number | null;
    signature: string | null;
  } | undefined;

  if (!account) return res.status(400).json({ error: "Email account not found or not verified" });

  const sig = account.signature?.trim() ?? null;
  const isHtmlSig = sig ? /<[a-z][\s\S]*>/i.test(sig) : false;
  const finalBody = sig && !isHtmlSig ? `${body.trim()}\n\n--\n${sig}` : body.trim();

  try {
    await sendEmail(
      {
        ...account,
        password: decryptSecret(account.password)!,
        imap_password: account.imap_password ? decryptSecret(account.imap_password) : null,
      },
      target.email,
      subject.trim(),
      finalBody,
      isHtmlSig ? sig : null,
    );

    const now = new Date().toISOString();
    db.prepare("UPDATE targets SET email_sent_at = COALESCE(email_sent_at, ?) WHERE id = ?").run(now, targetId);
    db.prepare(
      "INSERT INTO activity_logs (id, target_id, type, body, logged_at, created_at) VALUES (?, ?, 'email', ?, ?, ?)"
    ).run(randomUUID(), targetId, `[Manual] ${subject.trim()}\n\n${body.trim()}`, now, now);
    db.prepare(
      "INSERT INTO logs (id, run_id, target_id, level, message) VALUES (?, NULL, ?, 'info', ?)"
    ).run(randomUUID(), targetId, `Manual email sent: ${subject.trim()}`);

    return res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: msg });
  }
}

export const config = { api: { responseLimit: false } };
