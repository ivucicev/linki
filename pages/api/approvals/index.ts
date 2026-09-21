import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).end();

  const db = getDb();
  const rows = db.prepare(`
    SELECT rt.id, rt.pending_message, rt.pending_subject, rt.track,
           t.full_name, t.title, t.company, t.linkedin_url,
           r.id as run_id, w.name as workflow_name,
           ws.step_type,
           (SELECT COUNT(*) FROM workflow_steps ws2
            WHERE ws2.workflow_id = r.workflow_id
            AND ws2.track = rt.track
            AND ws2.step_type = ws.step_type
            AND ws2.step_order <= ws.step_order) as step_number,
           (SELECT COUNT(*) FROM run_profile_tracks rt2
            JOIN run_profiles rp2 ON rp2.id = rt2.run_profile_id
            WHERE rp2.run_id = r.id AND date(rt2.approved_at) = date('now')) as approved_today
    FROM run_profile_tracks rt
    JOIN run_profiles rp ON rp.id = rt.run_profile_id
    JOIN runs r ON r.id = rp.run_id
    JOIN workflows w ON w.id = r.workflow_id
    JOIN targets t ON t.id = rp.target_id
    JOIN workflow_steps ws ON ws.workflow_id = r.workflow_id AND ws.track = rt.track AND ws.step_order = rt.current_step + 1
    WHERE rt.approval_state = 'waiting'
    ORDER BY rt.rowid ASC
  `).all();

  return res.json(rows);
}
