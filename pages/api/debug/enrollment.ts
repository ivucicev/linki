import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).end();

  const db = getDb();

  const runs = db.prepare(`
    SELECT r.id as run_id, w.name as workflow_name, r.status, r.require_approval
    FROM runs r JOIN workflows w ON w.id = r.workflow_id
    WHERE r.status = 'running'
  `).all() as { run_id: string; workflow_name: string; status: string; require_approval: number }[];

  const result = runs.map(run => {
    const emailAccounts = (db.prepare(`
      SELECT DISTINCT rp.email_account_id FROM run_profiles rp
      WHERE rp.run_id = ? AND rp.email_account_id IS NOT NULL
    `).all(run.run_id) as { email_account_id: string }[]).map(r => r.email_account_id);

    const pendingEmailTracks = (db.prepare(`
      SELECT COUNT(*) as c FROM run_profile_tracks rt
      JOIN run_profiles rp ON rp.id = rt.run_profile_id
      WHERE rp.run_id = ? AND rt.track = 'email' AND rt.state = 'pending'
    `).get(run.run_id) as { c: number }).c;

    const pendingNewContacts = (db.prepare(`
      SELECT COUNT(*) as c FROM run_profile_tracks rt
      JOIN run_profiles rp ON rp.id = rt.run_profile_id
      WHERE rp.run_id = ? AND rt.track = 'email' AND rt.state = 'pending' AND rt.last_email_body IS NULL
    `).get(run.run_id) as { c: number }).c;

    const inProgressEmail = (db.prepare(`
      SELECT COUNT(*) as c FROM run_profile_tracks rt
      JOIN run_profiles rp ON rp.id = rt.run_profile_id
      WHERE rp.run_id = ? AND rt.track = 'email' AND rt.state = 'in_progress'
    `).get(run.run_id) as { c: number }).c;

    const waitingApprovals = (db.prepare(`
      SELECT COUNT(*) as c FROM run_profile_tracks rt
      JOIN run_profiles rp ON rp.id = rt.run_profile_id
      WHERE rp.run_id = ? AND rt.approval_state = 'waiting'
    `).get(run.run_id) as { c: number }).c;

    const approvedToday = (db.prepare(`
      SELECT COUNT(*) as c FROM run_profile_tracks rt
      JOIN run_profiles rp ON rp.id = rt.run_profile_id
      WHERE rp.run_id = ? AND date(rt.approved_at) = date('now')
    `).get(run.run_id) as { c: number }).c;

    const profilesWithNoEmailAccount = (db.prepare(`
      SELECT COUNT(*) as c FROM run_profiles rp
      WHERE rp.run_id = ? AND rp.email_account_id IS NULL
    `).get(run.run_id) as { c: number }).c;

    const emailAccountDetails = emailAccounts.map(accId => {
      const ea = db.prepare(`
        SELECT id, from_email, daily_email_limit, new_contact_daily_limit, ramp_up_enabled, ramp_start_date
        FROM email_accounts WHERE id = ?
      `).get(accId) as { id: string; from_email: string; daily_email_limit: number; new_contact_daily_limit: number | null; ramp_up_enabled: number | null; ramp_start_date: string | null } | undefined;

      const sentToday = (db.prepare(`
        SELECT COUNT(*) as c FROM logs l
        WHERE l.message LIKE 'Email sent%' AND date(l.created_at) = date('now')
        AND EXISTS (
          SELECT 1 FROM run_profiles rp WHERE rp.run_id = l.run_id AND rp.target_id = l.target_id AND rp.email_account_id = ?
        )
      `).get(accId) as { c: number }).c;

      const approvedTodayAcc = (db.prepare(`
        SELECT COUNT(*) as c FROM run_profile_tracks rt
        JOIN run_profiles rp ON rp.id = rt.run_profile_id
        WHERE rp.email_account_id = ? AND date(rt.approved_at) = date('now')
      `).get(accId) as { c: number }).c;

      const inFlightTotal = (db.prepare(`
        SELECT COUNT(*) as c FROM run_profile_tracks rt
        JOIN run_profiles rp ON rp.id = rt.run_profile_id
        WHERE rp.email_account_id = ? AND rt.track = 'email' AND rt.state = 'in_progress'
        AND (rt.approval_state IN ('waiting','approved') OR (rt.approval_state IS NULL AND datetime(rt.next_step_at) > datetime('now')))
      `).get(accId) as { c: number }).c;

      const inFlightNew = (db.prepare(`
        SELECT COUNT(*) as c FROM run_profile_tracks rt
        JOIN run_profiles rp ON rp.id = rt.run_profile_id
        WHERE rp.email_account_id = ? AND rt.track = 'email' AND rt.state = 'in_progress'
        AND (rt.approval_state IN ('waiting','approved') OR (rt.approval_state IS NULL AND datetime(rt.next_step_at) > datetime('now')))
        AND rt.last_email_body IS NULL
      `).get(accId) as { c: number }).c;

      let effectiveLimit = ea?.daily_email_limit ?? 50;
      if (ea?.ramp_up_enabled && ea?.ramp_start_date) {
        const daysActive = Math.max(1, Math.floor((Date.now() - new Date(ea.ramp_start_date).getTime()) / 86_400_000) + 1);
        effectiveLimit = Math.min(effectiveLimit, daysActive * 2);
      }

      return {
        id: accId,
        from_email: ea?.from_email ?? "NOT FOUND IN email_accounts",
        effectiveLimit,
        daily_email_limit: ea?.daily_email_limit,
        new_contact_daily_limit: ea?.new_contact_daily_limit,
        ramp_up_enabled: ea?.ramp_up_enabled,
        ramp_start_date: ea?.ramp_start_date,
        sentToday,
        approvedToday: approvedTodayAcc,
        inFlightTotal,
        inFlightNew,
        slotsLeft: Math.max(0, effectiveLimit - sentToday - inFlightTotal),
        newSlotsLeft: ea?.new_contact_daily_limit != null
          ? Math.max(0, Math.min(Math.max(0, effectiveLimit - sentToday - inFlightTotal), ea.new_contact_daily_limit - inFlightNew))
          : null,
      };
    });

    return {
      run_id: run.run_id,
      workflow_name: run.workflow_name,
      require_approval: run.require_approval,
      pendingEmailTracks,
      pendingNewContacts,
      inProgressEmail,
      waitingApprovals,
      approvedToday,
      profilesWithNoEmailAccount,
      emailAccountIds: emailAccounts,
      emailAccountDetails,
    };
  });

  return res.json(result);
}
