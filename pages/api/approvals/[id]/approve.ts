import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

function randomSlotInRemainingWindow(activeStart: number, activeEnd: number, timezone: string): string {
  const now = new Date();
  const safeZone = (() => { try { Intl.DateTimeFormat(undefined, { timeZone: timezone }); return timezone; } catch { return "UTC"; } })();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeZone, hour: "numeric", minute: "numeric", hour12: false,
  }).formatToParts(now);
  const hour = parseInt(parts.find(p => p.type === "hour")?.value ?? "0") % 24;
  const minute = parseInt(parts.find(p => p.type === "minute")?.value ?? "0");
  const nowFrac = hour + minute / 60;

  // Already past window — runner will reschedule to tomorrow on next tick
  if (nowFrac >= activeEnd) return now.toISOString();

  const windowStart = Math.max(nowFrac, activeStart);
  const remainingMs = (activeEnd - windowStart) * 3_600_000;
  return new Date(now.getTime() + Math.random() * remainingMs).toISOString();
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const db = getDb();
  const id = req.query.id as string;
  const { message, subject } = req.body as { message?: string; subject?: string };

  const existing = db.prepare("SELECT id, pending_message, pending_subject FROM run_profile_tracks WHERE id = ? AND approval_state = 'waiting'").get(id) as { id: string; pending_message: string | null; pending_subject: string | null } | undefined;
  if (!existing) return res.status(404).json({ error: "not found or not pending" });

  const finalMessage = message !== undefined ? message : existing.pending_message;
  const finalSubject = subject !== undefined ? subject : existing.pending_subject;

  // Look up schedule config so approved items spread across remaining active window today
  const scheduleRow = db.prepare(`
    SELECT rt.track,
           a.active_hours_start AS li_start, a.active_hours_end AS li_end, a.timezone AS li_tz,
           ea.active_hours_start AS ea_start, ea.active_hours_end AS ea_end, ea.timezone AS ea_tz
    FROM run_profile_tracks rt
    JOIN run_profiles rp ON rp.id = rt.run_profile_id
    JOIN runs r ON r.id = rp.run_id
    JOIN accounts a ON a.id = r.account_id
    LEFT JOIN email_accounts ea ON ea.id = rp.email_account_id
    WHERE rt.id = ?
  `).get(id) as { track: string; li_start: number; li_end: number; li_tz: string; ea_start: number | null; ea_end: number | null; ea_tz: string | null } | undefined;

  let nextStepAt: string;
  if (scheduleRow) {
    const isEmail = scheduleRow.track === "email";
    const start = isEmail ? (scheduleRow.ea_start ?? scheduleRow.li_start) : scheduleRow.li_start;
    const end   = isEmail ? (scheduleRow.ea_end   ?? scheduleRow.li_end)   : scheduleRow.li_end;
    const tz    = isEmail ? (scheduleRow.ea_tz    ?? scheduleRow.li_tz)    : scheduleRow.li_tz;
    nextStepAt = randomSlotInRemainingWindow(start ?? 9, end ?? 18, tz ?? "UTC");
  } else {
    nextStepAt = new Date().toISOString();
  }

  db.prepare(`
    UPDATE run_profile_tracks
    SET pending_message = ?, pending_subject = ?, approval_state = 'approved', next_step_at = ?
    WHERE id = ?
  `).run(finalMessage, finalSubject, nextStepAt, id);

  return res.json({ ok: true });
}
