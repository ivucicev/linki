import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";

const BOT_PATTERN = /bot|spider|crawler|preview|scanner|google|facebook|slack|twitter|linkedin|whatsapp|telegram|discord/i;

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "no-store");

  const { t: targetId, r: runId, s: stepId, u: url } = req.query as Record<string, string>;

  if (!url) {
    return res.status(400).end();
  }

  const decodedUrl = decodeURIComponent(url);
  const userAgent = (req.headers["user-agent"] ?? "") as string;

  // Skip bots — redirect without logging
  if (!BOT_PATTERN.test(userAgent)) {
    try {
      const db = getDb();
      const ip =
        (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
        req.socket.remoteAddress ??
        null;

      db.prepare(`
        INSERT INTO email_clicks (id, target_id, run_id, step_id, url, ip, user_agent)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), targetId ?? null, runId ?? null, stepId ?? null, decodedUrl, ip, userAgent || null);
    } catch {
      // Non-fatal — still redirect
    }
  }

  const escaped = decodedUrl.replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const encodedForMeta = decodedUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(
    `<!DOCTYPE html><html><head>` +
    `<meta http-equiv="refresh" content="0;url=${encodedForMeta}">` +
    `</head><body>` +
    `<script>window.location.href = decodeURIComponent("${encodeURIComponent(decodedUrl)}");</script>` +
    `<a href="${escaped}">Click here if not redirected</a>` +
    `</body></html>`
  );
}
