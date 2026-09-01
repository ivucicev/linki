import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";

const BOT_PATTERN = /bot|spider|crawler|preview|scanner|google|facebook|slack|twitter|linkedin|whatsapp|telegram|discord/i;

const TRANSPARENT_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Content-Type", "image/gif");
  res.setHeader("Cache-Control", "no-store, no-cache");

  const { t: targetId, r: runId, s: stepId } = req.query as Record<string, string>;
  const userAgent = (req.headers["user-agent"] ?? "") as string;

  // Skip bots — return pixel without logging
  if (!BOT_PATTERN.test(userAgent)) {
    try {
      const db = getDb();
      const ip =
        (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
        req.socket.remoteAddress ??
        null;

      db.prepare(`
        INSERT INTO email_opens (id, target_id, run_id, step_id, ip, user_agent)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), targetId ?? null, runId ?? null, stepId ?? null, ip, userAgent || null);
    } catch {
      // Non-fatal — still return pixel
    }
  }

  res.status(200).send(TRANSPARENT_GIF);
}
