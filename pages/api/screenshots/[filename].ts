import type { NextApiRequest, NextApiResponse } from "next";
import fs from "fs";
import path from "path";

const DATA_DIR = process.env.LINKI_DB_PATH
  ? path.dirname(process.env.LINKI_DB_PATH)
  : path.join(process.cwd(), "public");
const DIR = path.join(DATA_DIR, "screenshots");

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).end();

  const filename = req.query.filename as string;
  if (!filename || filename.includes("..") || !filename.endsWith(".png")) {
    return res.status(400).end();
  }

  const filepath = path.join(DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).end();

  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=3600");
  fs.createReadStream(filepath).pipe(res);
}
