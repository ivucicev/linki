import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const db = getDb();
  const id = req.query.id as string;
  const { message, subject } = req.body as { message?: string; subject?: string };

  const existing = db.prepare("SELECT id, pending_message, pending_subject FROM run_profile_tracks WHERE id = ? AND approval_state = 'waiting'").get(id) as { id: string; pending_message: string | null; pending_subject: string | null } | undefined;
  if (!existing) return res.status(404).json({ error: "not found or not pending" });

  const finalMessage = message !== undefined ? message : existing.pending_message;
  const finalSubject = subject !== undefined ? subject : existing.pending_subject;

  db.prepare(`
    UPDATE run_profile_tracks
    SET pending_message = ?, pending_subject = ?, approval_state = 'approved', next_step_at = datetime('now')
    WHERE id = ?
  `).run(finalMessage, finalSubject, id);

  return res.json({ ok: true });
}
