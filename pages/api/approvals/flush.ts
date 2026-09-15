import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const db = getDb();
  const result = db.prepare(`
    UPDATE run_profile_tracks
    SET state = 'pending', approval_state = NULL,
        pending_message = NULL, pending_subject = NULL, next_step_at = NULL
    WHERE approval_state = 'waiting'
  `).run();

  return res.json({ reset: result.changes });
}
