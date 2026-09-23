import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).end();
  const db = getDb();

  const accounts = db.prepare(`
    SELECT id, name, from_email, daily_email_limit, ramp_up_enabled, ramp_start_date
    FROM email_accounts
    ORDER BY name
  `).all() as {
    id: string; name: string; from_email: string;
    daily_email_limit: number; ramp_up_enabled: number; ramp_start_date: string | null;
  }[];

  // Sent per account per day for the last 7 days
  const dailySends = db.prepare(`
    SELECT rp.email_account_id,
           date(l.created_at) as day,
           COUNT(*) as sent
    FROM logs l
    JOIN run_profiles rp ON rp.run_id = l.run_id AND rp.target_id = l.target_id
    WHERE l.message LIKE 'Email sent%'
    AND l.created_at >= date('now', '-6 days')
    GROUP BY rp.email_account_id, date(l.created_at)
  `).all() as { email_account_id: string; day: string; sent: number }[];

  // Last 50 email send log entries across all accounts
  const recentLogs = db.prepare(`
    SELECT l.created_at, l.message, rp.email_account_id
    FROM logs l
    JOIN run_profiles rp ON rp.run_id = l.run_id AND rp.target_id = l.target_id
    WHERE l.message LIKE 'Email sent%'
    ORDER BY l.created_at DESC
    LIMIT 50
  `).all() as { created_at: string; message: string; email_account_id: string }[];

  // Guard trips today
  const guardTrips = db.prepare(`
    SELECT l.created_at, l.message, rp.email_account_id
    FROM logs l
    LEFT JOIN run_profiles rp ON rp.run_id = l.run_id AND rp.target_id = l.target_id
    WHERE (l.message LIKE '%Daily limit%' OR l.message LIKE '%limit guard%')
    AND date(l.created_at) = date('now')
    ORDER BY l.created_at DESC
    LIMIT 50
  `).all() as { created_at: string; message: string; email_account_id: string | null }[];

  function effectiveLimit(a: typeof accounts[0], date: Date) {
    if (!a.ramp_up_enabled || !a.ramp_start_date) return a.daily_email_limit;
    const start = new Date(a.ramp_start_date);
    const daysActive = Math.floor((date.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    return Math.min(a.daily_email_limit, daysActive * 2);
  }

  const now = new Date();
  // Build last 7 days list (UTC dates)
  const days: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  // Index sends: accountId -> day -> count
  const sendsIndex: Record<string, Record<string, number>> = {};
  for (const row of dailySends) {
    if (!sendsIndex[row.email_account_id]) sendsIndex[row.email_account_id] = {};
    sendsIndex[row.email_account_id][row.day] = row.sent;
  }

  const today = now.toISOString().slice(0, 10);

  // Approved today per account
  const approvedTodayRows = db.prepare(`
    SELECT rp.email_account_id, COUNT(*) as c
    FROM run_profile_tracks rt
    JOIN run_profiles rp ON rp.id = rt.run_profile_id
    WHERE date(rt.approved_at) = date('now')
    GROUP BY rp.email_account_id
  `).all() as { email_account_id: string; c: number }[];
  const approvedTodayIndex: Record<string, number> = {};
  for (const r of approvedTodayRows) approvedTodayIndex[r.email_account_id] = r.c;

  // Upcoming sends: approved but not yet sent, per account and per campaign
  const upcomingRows = db.prepare(`
    SELECT rp.email_account_id, r.id as run_id, w.name as workflow_name, COUNT(*) as c
    FROM run_profile_tracks rt
    JOIN run_profiles rp ON rp.id = rt.run_profile_id
    JOIN runs r ON r.id = rp.run_id
    JOIN workflows w ON w.id = r.workflow_id
    WHERE rt.approval_state = 'approved'
    GROUP BY rp.email_account_id, r.id
  `).all() as { email_account_id: string; run_id: string; workflow_name: string; c: number }[];

  const result = accounts.map(a => {
    const sentToday = sendsIndex[a.id]?.[today] ?? 0;
    const limit = effectiveLimit(a, now);
    const upcomingForAccount = upcomingRows.filter(r => r.email_account_id === a.id);
    const upcomingSends = upcomingForAccount.reduce((s, r) => s + r.c, 0);
    return {
      id: a.id,
      name: a.name,
      from_email: a.from_email,
      daily_email_limit: a.daily_email_limit,
      ramp_up_enabled: a.ramp_up_enabled,
      ramp_start_date: a.ramp_start_date,
      effective_limit_today: limit,
      sent_today: sentToday,
      approved_today: approvedTodayIndex[a.id] ?? 0,
      upcoming_sends: upcomingSends,
      upcoming_by_campaign: upcomingForAccount.map(r => ({ run_id: r.run_id, workflow_name: r.workflow_name, count: r.c })),
      days: days.map(day => ({
        day,
        sent: sendsIndex[a.id]?.[day] ?? 0,
        limit: effectiveLimit(a, new Date(day + "T12:00:00Z")),
      })),
    };
  });

  res.json({ accounts: result, days, recentLogs, guardTrips });
}
