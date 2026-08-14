import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const db = getDb();
  const id = req.query.id as string;

  const target = db.prepare("SELECT id FROM targets WHERE id = ?").get(id);
  if (!target) return res.status(404).json({ error: "Not found" });

  const now = new Date().toISOString();
  db.prepare(
    "UPDATE targets SET degree = 1, connected_at = COALESCE(connected_at, ?) WHERE id = ?"
  ).run(now, id);

  return res.json({ ok: true, connected_at: now });
}
