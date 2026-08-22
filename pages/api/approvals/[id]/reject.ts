import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const db = getDb();
  const id = req.query.id as string;

  const existing = db.prepare("SELECT id FROM run_profile_tracks WHERE id = ? AND approval_state = 'waiting'").get(id) as { id: string } | undefined;
  if (!existing) return res.status(404).json({ error: "not found or not pending" });

  db.prepare(`
    UPDATE run_profile_tracks
    SET state = 'skipped', error_message = 'Rejected by user',
        pending_message = NULL, pending_subject = NULL, approval_state = NULL
    WHERE id = ?
  `).run(id);

  return res.json({ ok: true });
}
