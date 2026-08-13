import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { hasPremium } from "@/lib/premium";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).end();
  if (!hasPremium) return res.status(403).json({ error: "Premium required" });

  const db = getDb();
  const integration = db
    .prepare("SELECT api_key FROM integrations WHERE key = 'openrouter'")
    .get() as { api_key: string } | undefined;

  const apiKey = integration?.api_key ? decryptSecret(integration.api_key) : null;
  if (!apiKey) return res.status(400).json({ error: "OpenRouter API key not configured" });

  try {
    const resp = await fetch("https://openrouter.ai/api/v1/models", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://linki.app",
        "X-Title": "Linki",
      },
    });

    if (!resp.ok) {
      return res.status(502).json({ error: `OpenRouter returned ${resp.status}` });
    }

    const data = (await resp.json()) as {
      data?: Array<{
        id: string;
        name?: string;
        context_length?: number;
        pricing?: { prompt?: string; completion?: string };
      }>;
    };

    const models = (data.data ?? [])
      .filter((m) => m.id && !m.id.includes(":free"))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        contextLength: m.context_length ?? null,
        pricingInputPer1M: m.pricing?.prompt ? Number(m.pricing.prompt) * 1_000_000 : null,
        pricingOutputPer1M: m.pricing?.completion ? Number(m.pricing.completion) * 1_000_000 : null,
      }));

    return res.json({ models });
  } catch (err) {
    console.error("[openrouter/models]", err);
    return res.status(500).json({ error: "Failed to fetch models from OpenRouter" });
  }
}
