import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const db = getDb();
  const workflowId = req.query.id as string;

  // Reset all failed tracks that have error_message across all active runs for this workflow
  const result = db.prepare(`
    UPDATE run_profile_tracks SET state = 'in_progress', error_message = NULL, next_step_at = NULL
    WHERE state = 'failed'
      AND error_message IS NOT NULL
      AND run_profile_id IN (
        SELECT rp.id FROM run_profiles rp
        JOIN runs r ON r.id = rp.run_id
        WHERE r.workflow_id = ? AND r.status IN ('running', 'paused')
      )
  `).run(workflowId);

  return res.json({ ok: true, retried: result.changes });
}
