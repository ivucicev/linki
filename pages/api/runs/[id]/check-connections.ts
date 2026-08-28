import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { getSessionPage, saveSessionState } from "@/lib/linkedin/session";
import { visitProfile } from "@/lib/linkedin/visit";

// POST /api/runs/[id]/check-connections
// Bulk: visits LinkedIn profiles for given target_ids and updates degree from live page.
// Runs sequentially to avoid hammering LinkedIn.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const db = getDb();
  const runId = req.query.id as string;
  const { target_ids } = req.body as { target_ids: string[] };

  if (!target_ids?.length) return res.status(400).json({ error: "target_ids required" });

  const run = db.prepare("SELECT account_id FROM runs WHERE id = ?").get(runId) as { account_id: string } | undefined;
  if (!run) return res.status(404).json({ error: "Run not found" });

  const targets = db.prepare(
    `SELECT id, linkedin_url FROM targets WHERE id IN (${target_ids.map(() => "?").join(",")})`
  ).all(...target_ids) as { id: string; linkedin_url: string | null }[];

  let checked = 0;
  let connected = 0;

  const page = await getSessionPage(run.account_id);
  try {
    for (const t of targets) {
      if (!t.linkedin_url) continue;
      try {
        const result = await visitProfile(page, t.linkedin_url);
        const now = new Date().toISOString();
        if (result.isFirstDegree) {
          db.prepare("UPDATE targets SET degree = 1, connected_at = COALESCE(connected_at, ?) WHERE id = ?").run(now, t.id);
          connected++;
        } else {
          db.prepare("UPDATE targets SET degree = NULL, connected_at = NULL WHERE id = ?").run(t.id);
        }
        if (result.messagingUrn) {
          db.prepare("UPDATE targets SET messaging_urn = ? WHERE id = ?").run(result.messagingUrn, t.id);
        }
        checked++;
      } catch { /* skip individual failures */ }
    }
  } finally {
    await page.close();
    await saveSessionState(run.account_id);
  }

  return res.json({ ok: true, checked, connected });
}
