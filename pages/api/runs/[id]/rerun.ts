import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const db = getDb();
  const runId = req.query.id as string;
  const { target_ids } = req.body as { target_ids: string[] };

  if (!target_ids?.length) return res.status(400).json({ error: "target_ids required" });

  const placeholders = target_ids.map(() => "?").join(",");
  const rpRows = db.prepare(
    `SELECT id FROM run_profiles WHERE run_id = ? AND target_id IN (${placeholders})`
  ).all(runId, ...target_ids) as { id: string }[];

  let reran = 0;
  for (const rp of rpRows) {
    const r = db.prepare(`
      UPDATE run_profile_tracks
      SET state = 'pending', current_step = 0, next_step_at = NULL,
          error_message = NULL, last_step_at = NULL,
          pending_message = NULL, pending_subject = NULL, approval_state = NULL
      WHERE run_profile_id = ? AND state IN ('completed', 'failed', 'skipped')
    `).run(rp.id);
    reran += r.changes;
  }

  return res.json({ ok: true, reran });
}
