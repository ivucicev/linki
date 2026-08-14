import type { NextApiRequest, NextApiResponse } from "next";
import { listScreenshots } from "@/lib/linkedin/screenshot";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).end();
  return res.json(listScreenshots());
}
