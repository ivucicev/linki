import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const db = getDb();
  const id = req.query.id as string;

  const target = db.prepare("SELECT id FROM targets WHERE id = ?").get(id);
  if (!target) return res.status(404).json({ error: "Not found" });

  db.prepare(
    "UPDATE targets SET degree = NULL, connected_at = NULL, messaging_urn = NULL WHERE id = ?"
  ).run(id);

  return res.json({ ok: true });
}
