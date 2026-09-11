import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { getSessionPage, saveSessionState } from "@/lib/linkedin/session";
import { visitProfile } from "@/lib/linkedin/visit";
import { resolveLinkedInAccount } from "@/lib/linkedin/resolve-account";
import { randomUUID } from "crypto";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const db = getDb();
  const { ids, account_id } = req.body as { ids?: string[]; account_id?: string };

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "ids required" });
  }

  const targets = (ids.map((id) =>
    db.prepare("SELECT id, full_name, linkedin_url, connection_requested_at FROM targets WHERE id = ?").get(id)
  ) as Array<{ id: string; full_name: string | null; linkedin_url: string | null; connection_requested_at: string | null } | undefined>)
    .filter((t): t is NonNullable<typeof t> => !!t?.linkedin_url);

  if (targets.length === 0) {
    return res.status(400).json({ error: "No targets with LinkedIn URL" });
  }

  const account = resolveLinkedInAccount(db, targets[0].id, account_id);
  if (!account) return res.status(400).json({ error: "No authenticated LinkedIn account" });

  res.status(202).json({ ok: true, queued: targets.length });

  (async () => {
    for (const target of targets) {
      const page = await getSessionPage(account.id);
      try {
        const result = await visitProfile(page, target.linkedin_url!, target.id);
        const now = new Date().toISOString();
        const wasRequestSent = !!target.connection_requested_at;

        let status: string;
        if (result.isFirstDegree) {
          db.prepare(
            "UPDATE targets SET degree = 1, connected_at = COALESCE(connected_at, ?), connection_rejected_at = NULL WHERE id = ?"
          ).run(now, target.id);
          status = "connected (1st degree)";
        } else if (result.isPending) {
          status = "pending";
        } else if (wasRequestSent) {
          db.prepare(
            "UPDATE targets SET degree = NULL, connected_at = NULL, connection_requested_at = NULL, connection_rejected_at = ? WHERE id = ?"
          ).run(now, target.id);
          status = "invite rejected or expired";
        } else {
          status = "not connected";
        }
        if (result.messagingUrn) {
          db.prepare("UPDATE targets SET messaging_urn = ? WHERE id = ?").run(result.messagingUrn, target.id);
        }
        db.prepare(
          "INSERT INTO activity_logs (id, target_id, type, body) VALUES (?, ?, 'other', ?)"
        ).run(randomUUID(), target.id, `Connection check: ${status}`);
      } catch (e) {
        console.error(`[bulk-check] Error checking ${target.full_name}:`, e instanceof Error ? e.message : e);
      } finally {
        await page.close();
        await saveSessionState(account.id).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 3000 + Math.random() * 2000));
    }
  })().catch(() => {});
}

export const config = { api: { responseLimit: false } };
