import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { syncEmailInbox } from "@/lib/email/inbox";

// POST /api/inbox/sync-email
// Manually trigger IMAP sync for all configured email accounts.
// Returns 202 immediately, runs in background.
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const db = getDb();
  const accounts = db
    .prepare("SELECT id FROM email_accounts WHERE imap_host IS NOT NULL AND imap_host != ''")
    .all() as { id: string }[];

  if (accounts.length === 0) return res.status(200).json({ ok: true, synced: 0 });

  res.status(202).json({ ok: true, accounts: accounts.length });

  (async () => {
    let replies = 0;
    let bounces = 0;
    for (const { id } of accounts) {
      try {
        const result = await syncEmailInbox(id);
        replies += result.replies;
        bounces += result.bounces;
      } catch (e) {
        console.warn(`[inbox/sync-email] Error syncing account ${id}:`, e instanceof Error ? e.message : e);
      }
    }
    console.log(`[inbox/sync-email] Manual sync complete — ${replies} replies, ${bounces} bounces across ${accounts.length} accounts`);
  })().catch(() => {});
}
