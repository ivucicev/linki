import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { getSessionPage, saveSessionState } from "@/lib/linkedin/session";
import { visitProfile } from "@/lib/linkedin/visit";
import { resolveLinkedInAccount } from "@/lib/linkedin/resolve-account";

// POST /api/targets/[id]/check-connection
// Visits the contact's LinkedIn profile and updates degree + messaging_urn from live page.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const db = getDb();
  const id = req.query.id as string;
  const target = db.prepare(
    "SELECT id, full_name, linkedin_url FROM targets WHERE id = ?"
  ).get(id) as { id: string; full_name: string | null; linkedin_url: string | null } | undefined;

  if (!target) return res.status(404).json({ error: "Not found" });
  if (!target.linkedin_url) return res.status(400).json({ error: "No LinkedIn URL" });

  const account = resolveLinkedInAccount(db, id, req.body?.account_id);
  if (!account) return res.status(400).json({ error: "No authenticated LinkedIn account" });

  try {
    const page = await getSessionPage(account.id);
    let result: { isFirstDegree: boolean; messagingUrn: string | null };
    try {
      result = await visitProfile(page, target.linkedin_url);
    } finally {
      await page.close();
    }
    await saveSessionState(account.id);

    const now = new Date().toISOString();
    if (result.isFirstDegree) {
      db.prepare(
        "UPDATE targets SET degree = 1, connected_at = COALESCE(connected_at, ?) WHERE id = ?"
      ).run(now, id);
    } else {
      db.prepare(
        "UPDATE targets SET degree = NULL, connected_at = NULL WHERE id = ?"
      ).run(id);
    }
    if (result.messagingUrn) {
      db.prepare(
        "UPDATE targets SET messaging_urn = ? WHERE id = ?"
      ).run(result.messagingUrn, id);
    }

    return res.json({ ok: true, isFirstDegree: result.isFirstDegree, messagingUrn: result.messagingUrn });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message });
  }
}
