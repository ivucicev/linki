import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const db = getDb();
  const runId = req.query.id as string;
  const { target_id } = req.body as { target_id: string };

  if (!target_id) return res.status(400).json({ error: "target_id required" });

  const rp = db.prepare(
    "SELECT id FROM run_profiles WHERE run_id = ? AND target_id = ?"
  ).get(runId, target_id) as { id: string } | undefined;

  if (!rp) return res.status(404).json({ error: "Profile not found" });

  db.prepare(
    `UPDATE run_profile_tracks SET state = 'completed'
     WHERE run_profile_id = ? AND state != 'completed'`
  ).run(rp.id);

  return res.json({ ok: true });
}
