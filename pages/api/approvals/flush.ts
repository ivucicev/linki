import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

function effectiveEmailLimit(account: {
  daily_email_limit: number;
  ramp_up_enabled: number | null;
  ramp_start_date: string | null;
}): number {
  if (!account.ramp_up_enabled || !account.ramp_start_date) return account.daily_email_limit;
  const daysActive = Math.max(1, Math.floor((Date.now() - new Date(account.ramp_start_date).getTime()) / 86_400_000) + 1);
  return Math.min(account.daily_email_limit, daysActive * 2);
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const db = getDb();
  let totalReset = 0;

  // Email tracks — cap per email account at its effective daily limit
  const emailAccounts = db.prepare(`
    SELECT DISTINCT rp.email_account_id,
      ea.daily_email_limit, ea.ramp_up_enabled, ea.ramp_start_date
    FROM run_profile_tracks rt
    JOIN run_profiles rp ON rp.id = rt.run_profile_id
    JOIN email_accounts ea ON ea.id = rp.email_account_id
    WHERE rt.approval_state = 'waiting' AND rt.track = 'email'
    AND rp.email_account_id IS NOT NULL
  `).all() as Array<{
    email_account_id: string;
    daily_email_limit: number;
    ramp_up_enabled: number | null;
    ramp_start_date: string | null;
  }>;

  for (const acc of emailAccounts) {
    const limit = effectiveEmailLimit(acc);
    const result = db.prepare(`
      UPDATE run_profile_tracks
      SET state = 'pending', approval_state = NULL,
          pending_message = NULL, pending_subject = NULL, next_step_at = NULL
      WHERE id IN (
        SELECT rt.id FROM run_profile_tracks rt
        JOIN run_profiles rp ON rp.id = rt.run_profile_id
        WHERE rp.email_account_id = ? AND rt.track = 'email' AND rt.approval_state = 'waiting'
        ORDER BY rt.rowid
        LIMIT -1 OFFSET ?
      )
    `).run(acc.email_account_id, limit);
    totalReset += result.changes;
  }

  // LinkedIn message tracks — cap per account at daily_message_limit
  const liMessageAccounts = db.prepare(`
    SELECT DISTINCT r.account_id, a.daily_message_limit
    FROM run_profile_tracks rt
    JOIN run_profiles rp ON rp.id = rt.run_profile_id
    JOIN runs r ON r.id = rp.run_id
    JOIN accounts a ON a.id = r.account_id
    JOIN workflow_steps ws ON ws.workflow_id = r.workflow_id
      AND ws.track = rt.track AND ws.step_order = rt.current_step + 1
    WHERE rt.approval_state = 'waiting' AND rt.track = 'linkedin'
    AND ws.step_type = 'message'
  `).all() as Array<{ account_id: string; daily_message_limit: number | null }>;

  for (const acc of liMessageAccounts) {
    const limit = acc.daily_message_limit ?? 50;
    const result = db.prepare(`
      UPDATE run_profile_tracks
      SET state = 'pending', approval_state = NULL,
          pending_message = NULL, pending_subject = NULL, next_step_at = NULL
      WHERE id IN (
        SELECT rt.id FROM run_profile_tracks rt
        JOIN run_profiles rp ON rp.id = rt.run_profile_id
        JOIN runs r ON r.id = rp.run_id
        JOIN workflow_steps ws ON ws.workflow_id = r.workflow_id
          AND ws.track = rt.track AND ws.step_order = rt.current_step + 1
        WHERE r.account_id = ? AND rt.track = 'linkedin' AND rt.approval_state = 'waiting'
        AND ws.step_type = 'message'
        ORDER BY rt.rowid
        LIMIT -1 OFFSET ?
      )
    `).run(acc.account_id, limit);
    totalReset += result.changes;
  }

  // LinkedIn sales_inmail tracks — cap per account at daily_inmail_limit
  const liInmailAccounts = db.prepare(`
    SELECT DISTINCT r.account_id, a.daily_inmail_limit
    FROM run_profile_tracks rt
    JOIN run_profiles rp ON rp.id = rt.run_profile_id
    JOIN runs r ON r.id = rp.run_id
    JOIN accounts a ON a.id = r.account_id
    JOIN workflow_steps ws ON ws.workflow_id = r.workflow_id
      AND ws.track = rt.track AND ws.step_order = rt.current_step + 1
    WHERE rt.approval_state = 'waiting' AND rt.track = 'linkedin'
    AND ws.step_type = 'sales_inmail'
  `).all() as Array<{ account_id: string; daily_inmail_limit: number | null }>;

  for (const acc of liInmailAccounts) {
    const limit = acc.daily_inmail_limit ?? 15;
    const result = db.prepare(`
      UPDATE run_profile_tracks
      SET state = 'pending', approval_state = NULL,
          pending_message = NULL, pending_subject = NULL, next_step_at = NULL
      WHERE id IN (
        SELECT rt.id FROM run_profile_tracks rt
        JOIN run_profiles rp ON rp.id = rt.run_profile_id
        JOIN runs r ON r.id = rp.run_id
        JOIN workflow_steps ws ON ws.workflow_id = r.workflow_id
          AND ws.track = rt.track AND ws.step_order = rt.current_step + 1
        WHERE r.account_id = ? AND rt.track = 'linkedin' AND rt.approval_state = 'waiting'
        AND ws.step_type = 'sales_inmail'
        ORDER BY rt.rowid
        LIMIT -1 OFFSET ?
      )
    `).run(acc.account_id, limit);
    totalReset += result.changes;
  }

  return res.json({ reset: totalReset });
}
