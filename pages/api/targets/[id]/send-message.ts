import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { getSessionPage, saveSessionState } from "@/lib/linkedin/session";
import { sendMessage } from "@/lib/linkedin/message";
import { premium } from "@/lib/premium";
import { randomUUID } from "crypto";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const db = getDb();
  const targetId = req.query.id as string;
  const { account_id, type, message, subject } = req.body as {
    account_id: string;
    type: "message" | "inmail";
    message: string;
    subject?: string;
  };

  if (!account_id || !type || !message) return res.status(400).json({ error: "account_id, type, message required" });

  const target = db.prepare("SELECT * FROM targets WHERE id = ?").get(targetId) as {
    id: string; full_name: string | null; linkedin_url: string | null;
    sales_nav_url: string | null; messaging_urn: string | null; degree: number | null;
  } | undefined;
  if (!target) return res.status(404).json({ error: "Target not found" });

  if (type === "message" && !target.linkedin_url) return res.status(400).json({ error: "Contact has no LinkedIn URL" });
  if (type === "inmail" && !target.sales_nav_url) return res.status(400).json({ error: "Contact has no Sales Nav URL" });
  if (type === "inmail" && !subject) return res.status(400).json({ error: "Subject required for InMail" });

  const account = db.prepare("SELECT id, is_authenticated FROM accounts WHERE id = ?").get(account_id) as { id: string; is_authenticated: number } | undefined;
  if (!account?.is_authenticated) return res.status(400).json({ error: "Account not authenticated" });

  const page = await getSessionPage(account_id);
  try {
    if (type === "message") {
      const result = await sendMessage(page, target.full_name ?? "", message, target.linkedin_url!, target.messaging_urn ?? undefined, targetId);
      if (result.messagingUrn) {
        db.prepare("UPDATE targets SET messaging_urn = COALESCE(messaging_urn, ?) WHERE id = ?").run(result.messagingUrn, targetId);
      }
      db.prepare("UPDATE targets SET message_sent_at = COALESCE(message_sent_at, datetime('now')) WHERE id = ?").run(targetId);
    } else {
      if (!premium?.inmail) return res.status(400).json({ error: "InMail is a premium feature" });
      await premium.inmail.sendInMail(page, target.sales_nav_url!, subject!, message);
      db.prepare("UPDATE targets SET inmail_sent_at = COALESCE(inmail_sent_at, datetime('now')), message_sent_at = COALESCE(message_sent_at, datetime('now')) WHERE id = ?").run(targetId);
    }
    await saveSessionState(account_id);
    db.prepare("INSERT INTO logs (id, run_id, target_id, level, message) VALUES (?, NULL, ?, 'info', ?)").run(
      randomUUID(), targetId, `Manual ${type === "inmail" ? "InMail" : "message"} sent`
    );
    return res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: msg });
  } finally {
    await page.close();
  }
}

export const config = { api: { responseLimit: false } };
