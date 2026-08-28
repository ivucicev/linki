import type { NextApiRequest, NextApiResponse } from "next";
import { listScreenshots, clearScreenshots } from "@/lib/linkedin/screenshot";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const targetId = req.query.targetId as string | undefined;

  if (req.method === "GET") {
    return res.json(listScreenshots(targetId));
  }

  if (req.method === "DELETE") {
    const deleted = clearScreenshots(targetId);
    return res.json({ ok: true, deleted });
  }

  return res.status(405).end();
}
