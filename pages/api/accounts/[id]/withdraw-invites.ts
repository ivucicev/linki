import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { withdrawOldestInvites } from "@/lib/linkedin/withdraw-invites";

// POST /api/accounts/[id]/withdraw-invites
// Manually trigger withdrawal of oldest pending invites. Returns 202 immediately.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const db = getDb();
  const accountId = req.query.id as string;
  const count = Number(req.body?.count ?? 30);

  const account = db.prepare("SELECT id FROM accounts WHERE id = ?").get(accountId) as { id: string } | undefined;
  if (!account) return res.status(404).json({ error: "Account not found" });

  res.status(202).json({ ok: true, queued: count });

  (async () => {
    try {
      const withdrawn = await withdrawOldestInvites(accountId, count);
      console.log(`[withdraw-invites] Manual trigger: withdrew ${withdrawn} invites for account ${accountId}`);
    } catch (e) {
      console.error("[withdraw-invites] Manual trigger error:", e);
    }
  })().catch(() => {});
}
