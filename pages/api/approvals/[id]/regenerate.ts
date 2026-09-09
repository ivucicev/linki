import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { premium } from "@/lib/premium";
import { decryptSecret } from "@/lib/crypto";
import { randomUUID } from "crypto";

function renderTemplate(body: string, target: Record<string, string | null>): string {
  return body
    .replace(/\{\{first_name\}\}/gi, target.first_name ?? target.full_name?.split(" ")[0] ?? "")
    .replace(/\{\{last_name\}\}/gi, target.last_name ?? target.full_name?.split(" ").slice(1).join(" ") ?? "")
    .replace(/\{\{full_name\}\}/gi, target.full_name ?? "")
    .replace(/\{\{company\}\}/gi, target.company ?? "")
    .replace(/\{\{title\}\}/gi, target.title ?? "")
    .replace(/\{\{location\}\}/gi, target.location ?? "")
    .trim();
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const db = getDb();
  const id = req.query.id as string;

  const row = db.prepare(
    `SELECT rt.id, rt.current_step, rt.track, rt.last_email_body, rt.last_email_subject, rt.last_linkedin_message, rt.pending_reply_context,
            rp.target_id, rp.email_account_id, r.id as run_id, r.workflow_id, r.require_approval
     FROM run_profile_tracks rt
     JOIN run_profiles rp ON rp.id = rt.run_profile_id
     JOIN runs r ON r.id = rp.run_id
     WHERE rt.id = ? AND rt.approval_state = 'waiting'`
  ).get(id) as {
    id: string; current_step: number; track: string;
    last_email_body: string | null; last_email_subject: string | null; last_linkedin_message: string | null;
    pending_reply_context: string | null;
    target_id: string; email_account_id: string | null; run_id: string; workflow_id: string;
  } | undefined;

  if (!row) return res.status(404).json({ error: "Approval not found" });

  const step = db.prepare(
    `SELECT * FROM workflow_steps WHERE workflow_id = ? AND track = ? ORDER BY step_order LIMIT 1 OFFSET ?`
  ).get(row.workflow_id, row.track, row.current_step) as {
    step_type: string; template_id: string | null; message_body: string | null;
    email_subject: string | null; email_body: string | null;
    ai_enabled: number | null; ai_model: string | null; ai_prompt: string | null;
    ai_max_words: number | null; ai_language: string | null;
    email_position: number | null; message_position: number | null;
    id: string;
  } | undefined;

  if (!step) return res.status(404).json({ error: "Step not found" });

  const target = db.prepare("SELECT * FROM targets WHERE id = ?").get(row.target_id) as Record<string, string | null> | undefined;
  if (!target) return res.status(404).json({ error: "Target not found" });

  const campaignPrompt = (db.prepare("SELECT prompt FROM workflows WHERE id = ?").get(row.workflow_id) as { prompt: string | null } | undefined)?.prompt ?? null;

  let message = "";
  let subject = "";

  if (step.ai_enabled && premium?.ai) {
    const integration = db.prepare("SELECT api_key FROM integrations WHERE key = 'openrouter'").get() as { api_key: string } | undefined;
    const agentCfg = premium.ai.getAgentConfig();
    const model = step.ai_model || agentCfg.default_model;
    const contactData = premium.ai.getContactWithCompany(row.target_id);

    if (!integration?.api_key || !model || !contactData) {
      return res.status(400).json({ error: "AI not configured or contact data missing" });
    }

    const apiKey = decryptSecret(integration.api_key)!;

    if (step.step_type === "email") {
      const emailPosition = step.email_position ?? 1;
      const followupContext = emailPosition > 1 && (row.last_email_subject || row.last_email_body)
        ? { followupNumber: emailPosition - 1, previousSubject: row.last_email_subject ?? "", previousBody: row.last_email_body ?? "" }
        : undefined;
      const result = await premium.ai.writeEmail({
        apiKey, model, stepType: "email", stepPrompt: step.ai_prompt ?? "",
        maxWords: step.ai_max_words ?? undefined, language: step.ai_language ?? undefined,
        campaignPrompt: campaignPrompt ?? undefined, contact: contactData.contact, company: contactData.company,
        agentConfig: agentCfg, followupContext, replyContext: row.pending_reply_context ?? undefined,
        runId: row.run_id, targetId: row.target_id, stepId: step.id,
      });
      message = result.body;
      subject = result.subject;
    } else {
      const msgPosition = step.message_position ?? 1;
      const previousMessageContext = msgPosition > 1 && row.last_linkedin_message
        ? { followupNumber: msgPosition - 1, previousMessage: row.last_linkedin_message }
        : undefined;
      const result = await premium.ai.writeLinkedInMessage({
        apiKey, model, stepType: step.step_type as "message" | "sales_inmail",
        stepPrompt: step.ai_prompt ?? "", maxWords: step.ai_max_words ?? undefined,
        language: step.ai_language ?? undefined, campaignPrompt: campaignPrompt ?? undefined,
        contact: contactData.contact, company: contactData.company,
        agentConfig: agentCfg, previousMessageContext,
        runId: row.run_id, targetId: row.target_id, stepId: step.id,
      });
      message = result.body;
      subject = "";
    }
  } else {
    // Template-based
    const multiTemplateIds = (db.prepare("SELECT template_id FROM workflow_step_templates WHERE step_id = ?").all(step.id) as Array<{ template_id: string }>).map(r => r.template_id);
    let templateBody = "";
    if (multiTemplateIds.length > 0) {
      const randomId = multiTemplateIds[Math.floor(Math.random() * multiTemplateIds.length)];
      const tmpl = db.prepare("SELECT * FROM templates WHERE id = ?").get(randomId) as { body: string } | undefined;
      if (tmpl) templateBody = tmpl.body;
    } else if (step.template_id) {
      const tmpl = db.prepare("SELECT * FROM templates WHERE id = ?").get(step.template_id) as { body: string } | undefined;
      if (tmpl) templateBody = tmpl.body;
    }
    message = renderTemplate(templateBody || step.message_body || step.email_body || "", target);
    subject = renderTemplate(step.email_subject ?? "", target);
  }

  if (!message) return res.status(400).json({ error: "Could not generate message" });

  // Save so a page refresh preserves the regenerated content
  db.prepare(
    "UPDATE run_profile_tracks SET pending_message = ?, pending_subject = ? WHERE id = ?"
  ).run(message, subject || null, id);

  return res.json({ message, subject: subject || null });
}
