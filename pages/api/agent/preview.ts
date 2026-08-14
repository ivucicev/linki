import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { premium } from "@/lib/premium";
import { decryptSecret } from "@/lib/crypto";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();
  if (!premium?.ai) return res.status(400).json({ error: "AI features not available" });

  const { step_type, ai_model, ai_prompt, ai_max_words, ai_language, target_id, campaign_prompt } = req.body ?? {};

  if (!target_id || !step_type) return res.status(400).json({ error: "target_id and step_type required" });

  const db = getDb();
  const integration = db
    .prepare("SELECT api_key FROM integrations WHERE key = 'openrouter'")
    .get() as { api_key: string } | undefined;

  if (!integration?.api_key) return res.status(400).json({ error: "OpenRouter API key not configured" });

  const agentConfig = premium.ai.getAgentConfig();
  const model = ai_model || agentConfig.default_model;
  if (!model) return res.status(400).json({ error: "No AI model configured. Set a default model in Agent settings." });

  const apiKey = decryptSecret(integration.api_key);
  if (!apiKey) return res.status(500).json({ error: "Failed to decrypt OpenRouter API key" });

  try {
    const result = await premium.ai.previewMessage({
      stepType: step_type,
      model,
      apiKey,
      targetId: target_id,
      stepPrompt: ai_prompt ?? "",
      maxWords: ai_max_words ?? null,
      language: ai_language ?? null,
      campaignPrompt: campaign_prompt ?? null,
    });

    return res.json({
      body: result.body,
      subject: result.subject,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      cost_usd: result.costUsd,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Preview failed";
    return res.status(500).json({ error: msg });
  }
}
