import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).end();

  const db = getDb();

  // All waiting approvals — raw, no joins that could silently drop rows
  const waiting = db.prepare(`
    SELECT rt.id, rt.track, rt.state, rt.approval_state, rt.current_step,
           rt.next_step_at, rt.pending_message IS NOT NULL as has_message,
           rt.approved_at,
           rp.run_id, rp.email_account_id,
           r.require_approval, r.status as run_status,
           w.name as workflow_name
    FROM run_profile_tracks rt
    JOIN run_profiles rp ON rp.id = rt.run_profile_id
    JOIN runs r ON r.id = rp.run_id
    JOIN workflows w ON w.id = r.workflow_id
    WHERE rt.approval_state = 'waiting'
    ORDER BY rt.rowid ASC
  `).all();

  // In-progress email tracks for require_approval runs that are NOT yet waiting
  const pendingGeneration = db.prepare(`
    SELECT rt.id, rt.track, rt.state, rt.approval_state, rt.current_step,
           rt.next_step_at, rt.pending_message IS NOT NULL as has_message,
           rp.run_id, rp.email_account_id,
           r.require_approval, r.status as run_status,
           w.name as workflow_name,
           CASE WHEN datetime(rt.next_step_at) <= datetime('now') THEN 'overdue'
                ELSE 'future' END as timing
    FROM run_profile_tracks rt
    JOIN run_profiles rp ON rp.id = rt.run_profile_id
    JOIN runs r ON r.id = rp.run_id
    JOIN workflows w ON w.id = r.workflow_id
    WHERE rt.state = 'in_progress'
      AND rt.approval_state IS NULL
      AND rt.track = 'email'
      AND r.require_approval = 1
      AND r.status = 'running'
    ORDER BY rt.next_step_at ASC
    LIMIT 50
  `).all();

  return res.json({ waiting, pendingGeneration });
}
