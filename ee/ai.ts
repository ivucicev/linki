import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";
import type { AiSurface } from "@/lib/premium";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

interface AgentConfigRow {
  default_model: string | null;
  system_prompt: string | null;
  user_prompt: string | null;
  email_examples: string | null;
  linkedin_examples: string | null;
}

// Input/output price per million tokens for known OpenRouter model IDs.
// Fallback applied when the model is not in the map.
const MODEL_PRICE: Record<string, [number, number]> = {
  "openai/gpt-4o":                   [2.5,   10],
  "openai/gpt-4o-mini":              [0.15,  0.6],
  "openai/gpt-4-turbo":              [10,    30],
  "anthropic/claude-3.5-sonnet":     [3,     15],
  "anthropic/claude-3-5-sonnet":     [3,     15],
  "anthropic/claude-3-haiku":        [0.25,  1.25],
  "anthropic/claude-3-opus":         [15,    75],
  "google/gemini-flash-1.5":         [0.075, 0.30],
  "google/gemini-pro-1.5":           [1.25,  5],
  "mistralai/mistral-7b-instruct":   [0.07,  0.07],
  "mistralai/mixtral-8x7b-instruct": [0.24,  0.24],
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const [inPrice, outPrice] = MODEL_PRICE[model] ?? [1, 3];
  return (inputTokens * inPrice + outputTokens * outPrice) / 1_000_000;
}

async function callOpenRouter(
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://linki.app",
      "X-Title": "Linki",
    },
    body: JSON.stringify({ model, messages, temperature: 0.7 }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`OpenRouter ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const content = data.choices?.[0]?.message?.content ?? "";
  const inputTokens = data.usage?.prompt_tokens ?? 0;
  const outputTokens = data.usage?.completion_tokens ?? 0;
  return { content, inputTokens, outputTokens };
}

function recordSession(params: {
  runId?: string;
  targetId?: string;
  stepId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  prompt: string;
  generatedText: string;
}) {
  const db = getDb();
  const costUsd = estimateCost(params.model, params.inputTokens, params.outputTokens);
  db.prepare(
    `INSERT INTO agent_sessions (id, run_id, target_id, step_id, model, input_tokens, output_tokens, cost_usd, prompt, generated_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    params.runId ?? null,
    params.targetId ?? null,
    params.stepId ?? null,
    params.model,
    params.inputTokens,
    params.outputTokens,
    costUsd,
    params.prompt,
    params.generatedText,
  );
}

function buildContactBlock(contact: AnyRecord, company: AnyRecord | null): string {
  const lines: string[] = [];
  if (contact.full_name)   lines.push(`Name: ${contact.full_name}`);
  if (contact.title)       lines.push(`Title: ${contact.title}`);
  if (contact.headline)    lines.push(`Headline: ${contact.headline}`);
  if (contact.company)     lines.push(`Company: ${contact.company}`);
  if (contact.seniority)   lines.push(`Seniority: ${contact.seniority}`);
  if (contact.location)    lines.push(`Location: ${contact.location}`);
  if (contact.summary)     lines.push(`Summary: ${String(contact.summary).slice(0, 400)}`);

  if (contact.positions_json) {
    try {
      const positions = JSON.parse(String(contact.positions_json)) as AnyRecord[];
      if (Array.isArray(positions) && positions.length > 0) {
        const pos = positions.slice(0, 3)
          .map((p) => `${p.title || ""}${p.companyName ? ` at ${p.companyName}` : ""}${p.current ? " (current)" : ""}`)
          .join("; ");
        if (pos.trim()) lines.push(`Work history: ${pos}`);
      }
    } catch { /* ignore */ }
  }

  if (contact.skills_json) {
    try {
      const skills = JSON.parse(String(contact.skills_json)) as AnyRecord[];
      if (Array.isArray(skills) && skills.length > 0) {
        const sk = skills.slice(0, 6).map((s) => s.name ?? s).join(", ");
        if (sk) lines.push(`Skills: ${sk}`);
      }
    } catch { /* ignore */ }
  }

  if (contact.posts_json) {
    try {
      const posts = JSON.parse(String(contact.posts_json)) as AnyRecord[];
      if (Array.isArray(posts) && posts.length > 0) {
        const p = posts[0];
        const text = String(p.text || p.content || "").slice(0, 300);
        if (text) lines.push(`Recent LinkedIn post: ${text}`);
      }
    } catch { /* ignore */ }
  }

  if (company) {
    if (company.name)         lines.push(`Company: ${company.name}`);
    if (company.industry)     lines.push(`Industry: ${company.industry}`);
    if (company.employee_count) lines.push(`Company size: ${company.employee_count} employees`);
    if (company.description)  lines.push(`Company description: ${String(company.description).slice(0, 300)}`);
    if (company.location)     lines.push(`Company location: ${company.location}`);
    if (company.website)      lines.push(`Website: ${company.website}`);
    if (company.keywords)     lines.push(`Company keywords: ${company.keywords}`);
  }

  return lines.join("\n");
}

function parseJsonBlock<T>(text: string): T | null {
  // Strip markdown code fences if present
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Try to extract the first {...} block
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]) as T; } catch { /* fall through */ }
    }
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getAgentConfig(): AgentConfigRow & { default_model: string | null } {
  const db = getDb();
  const row = db.prepare("SELECT * FROM agent_config WHERE id = 1").get() as AgentConfigRow | undefined;
  return {
    default_model: row?.default_model ?? null,
    system_prompt: row?.system_prompt ?? null,
    user_prompt: row?.user_prompt ?? null,
    email_examples: row?.email_examples ?? null,
    linkedin_examples: row?.linkedin_examples ?? null,
  };
}

export function getContactWithCompany(
  targetId: string,
): { contact: AnyRecord; company: AnyRecord | null } | null {
  const db = getDb();
  const contact = db.prepare("SELECT * FROM targets WHERE id = ?").get(targetId) as AnyRecord | undefined;
  if (!contact) return null;
  const company = contact.company_id
    ? (db.prepare("SELECT * FROM companies WHERE id = ?").get(contact.company_id) as AnyRecord | null)
    : null;
  return { contact, company: company ?? null };
}

export async function writeLinkedInMessage(params: AnyRecord): Promise<{ body: string }> {
  const {
    apiKey, model, stepPrompt, maxWords, language, campaignPrompt,
    contact, company, agentConfig, previousMessageContext,
    runId, targetId, stepId,
  } = params as {
    apiKey: string; model: string; stepPrompt: string;
    maxWords?: number; language?: string; campaignPrompt?: string;
    contact: AnyRecord; company: AnyRecord | null;
    agentConfig: AgentConfigRow;
    previousMessageContext?: { followupNumber: number; previousMessage: string };
    runId: string; targetId: string; stepId: string;
  };

  const wordLimit = maxWords ? `\nKeep it under ${maxWords} words.` : "";
  const lang = language && language !== "English" ? `\nWrite in ${language}.` : "";

  const systemLines = [
    agentConfig.system_prompt?.trim() ||
      "You are an expert B2B sales copywriter specialising in personalised LinkedIn outreach.",
    "Write messages that feel human and personal — never generic or template-like.",
    "Do NOT include greetings like 'Hi {{first_name}}' or sign-offs. Return only the message body.",
  ];

  const userLines: string[] = [
    "Write a LinkedIn message to the following person.",
    "",
    "=== CONTACT INFO ===",
    buildContactBlock(contact, company),
  ];

  if (campaignPrompt?.trim()) {
    userLines.push("", "=== CAMPAIGN CONTEXT ===", campaignPrompt.trim());
  }
  if (agentConfig.user_prompt?.trim()) {
    userLines.push("", "=== GUIDELINES ===", agentConfig.user_prompt.trim());
  }
  if (agentConfig.linkedin_examples?.trim()) {
    userLines.push("", "=== EXAMPLE MESSAGES ===", agentConfig.linkedin_examples.trim());
  }
  if (previousMessageContext) {
    userLines.push(
      "",
      `=== FOLLOW-UP CONTEXT (follow-up #${previousMessageContext.followupNumber}) ===`,
      `Previous message sent:\n${previousMessageContext.previousMessage}`,
      "Write a natural follow-up — acknowledge no reply, add new value, stay concise.",
    );
  }

  if (stepPrompt?.trim()) {
    userLines.push("", "=== STEP INSTRUCTIONS ===", stepPrompt.trim());
  }
  userLines.push("", wordLimit + lang + "\nReturn only the message body text.");

  const messages = [
    { role: "system", content: systemLines.join("\n") },
    { role: "user", content: userLines.join("\n") },
  ];

  const { content, inputTokens, outputTokens } = await callOpenRouter(apiKey, model, messages);

  recordSession({
    runId, targetId, stepId, model,
    inputTokens, outputTokens,
    prompt: userLines.join("\n"),
    generatedText: content,
  });

  return { body: content.trim() };
}

export async function writeSalesInMail(params: AnyRecord): Promise<{ subject: string; body: string }> {
  const {
    apiKey, model, stepPrompt, maxWords, language, campaignPrompt,
    contact, company, agentConfig, previousMessageContext,
    runId, targetId, stepId,
  } = params as {
    apiKey: string; model: string; stepPrompt: string;
    maxWords?: number; language?: string; campaignPrompt?: string;
    contact: AnyRecord; company: AnyRecord | null;
    agentConfig: AgentConfigRow;
    previousMessageContext?: { followupNumber: number; previousMessage: string };
    runId: string; targetId: string; stepId: string;
  };

  const wordLimit = maxWords ? `Keep the body under ${maxWords} words.` : "";
  const lang = language && language !== "English" ? `Write in ${language}.` : "";

  const systemLines = [
    agentConfig.system_prompt?.trim() ||
      "You are an expert B2B sales copywriter specialising in LinkedIn Sales Navigator InMails.",
    "InMails reach non-connections — the subject line is critical to getting opened.",
    "Write concise, personalised messages that feel human. Avoid generic openers.",
  ];

  const userLines: string[] = [
    "Write a LinkedIn Sales Navigator InMail (subject + body) to the following person.",
    "",
    "=== CONTACT INFO ===",
    buildContactBlock(contact, company),
  ];

  if (campaignPrompt?.trim()) {
    userLines.push("", "=== CAMPAIGN CONTEXT ===", campaignPrompt.trim());
  }
  if (agentConfig.user_prompt?.trim()) {
    userLines.push("", "=== GUIDELINES ===", agentConfig.user_prompt.trim());
  }
  if (agentConfig.linkedin_examples?.trim()) {
    userLines.push("", "=== EXAMPLE MESSAGES ===", agentConfig.linkedin_examples.trim());
  }
  if (previousMessageContext) {
    userLines.push(
      "",
      `=== FOLLOW-UP CONTEXT (follow-up #${previousMessageContext.followupNumber}) ===`,
      `Previous InMail sent:\n${previousMessageContext.previousMessage}`,
    );
  }
  if (stepPrompt?.trim()) {
    userLines.push("", "=== STEP INSTRUCTIONS ===", stepPrompt.trim());
  }
  userLines.push("", wordLimit, lang);
  userLines.push(
    `Return ONLY valid JSON in this exact format:`,
    `{"subject": "<subject line>", "body": "<message body>"}`,
  );

  const messages = [
    { role: "system", content: systemLines.join("\n") },
    { role: "user", content: userLines.join("\n") },
  ];

  const { content, inputTokens, outputTokens } = await callOpenRouter(apiKey, model, messages);

  recordSession({
    runId, targetId, stepId, model,
    inputTokens, outputTokens,
    prompt: userLines.join("\n"),
    generatedText: content,
  });

  const parsed = parseJsonBlock<{ subject?: string; body?: string }>(content);
  if (parsed?.subject && parsed?.body) {
    return { subject: parsed.subject.trim(), body: parsed.body.trim() };
  }

  // Fallback: treat first line as subject, rest as body
  const lines = content.trim().split("\n");
  const subject = lines[0].replace(/^subject:\s*/i, "").trim();
  const body = lines.slice(1).join("\n").trim();
  return { subject, body: body || content.trim() };
}

export async function writeEmail(params: AnyRecord): Promise<{ subject: string; body: string }> {
  const {
    apiKey, model, stepPrompt, maxWords, language, campaignPrompt,
    contact, company, agentConfig, followupContext, replyContext,
    runId, targetId, stepId,
  } = params as {
    apiKey: string; model: string; stepPrompt: string;
    maxWords?: number; language?: string; campaignPrompt?: string;
    contact: AnyRecord; company: AnyRecord | null;
    agentConfig: AgentConfigRow;
    followupContext?: { followupNumber: number; previousSubject: string; previousBody: string };
    replyContext?: string;
    runId: string; targetId: string; stepId: string;
  };

  const wordLimit = maxWords ? `Keep the body under ${maxWords} words.` : "";
  const lang = language && language !== "English" ? `Write in ${language}.` : "";

  const systemLines = [
    agentConfig.system_prompt?.trim() ||
      "You are an expert B2B cold email copywriter writing personalised outreach emails.",
    "Emails should be short, specific, and value-focused. Avoid buzzwords and generic openers.",
    "Do NOT include salutations (Hi/Hello) or sign-offs — the caller handles those.",
  ];

  const userLines: string[] = [
    "Write a personalised cold email to the following person.",
    "",
    "=== CONTACT INFO ===",
    buildContactBlock(contact, company),
  ];

  if (campaignPrompt?.trim()) {
    userLines.push("", "=== CAMPAIGN CONTEXT ===", campaignPrompt.trim());
  }
  if (agentConfig.user_prompt?.trim()) {
    userLines.push("", "=== GUIDELINES ===", agentConfig.user_prompt.trim());
  }
  if (agentConfig.email_examples?.trim()) {
    userLines.push("", "=== EXAMPLE EMAILS ===", agentConfig.email_examples.trim());
  }
  if (replyContext?.trim()) {
    userLines.push(
      "",
      "=== OOO REPLY RECEIVED ===",
      replyContext.trim(),
      "Acknowledge that you saw they were away. Don't make a big deal of it.",
    );
  }
  if (followupContext) {
    userLines.push(
      "",
      `=== FOLLOW-UP CONTEXT (follow-up email #${followupContext.followupNumber}) ===`,
      `Previous subject: ${followupContext.previousSubject}`,
      `Previous body:\n${followupContext.previousBody}`,
      "Write a natural follow-up — add new value, reference the previous email lightly, stay short.",
    );
  }
  if (stepPrompt?.trim()) {
    userLines.push("", "=== STEP INSTRUCTIONS ===", stepPrompt.trim());
  }
  userLines.push("", wordLimit, lang);
  userLines.push(
    `Return ONLY valid JSON in this exact format:`,
    `{"subject": "<email subject>", "body": "<email body>"}`,
  );

  const messages = [
    { role: "system", content: systemLines.join("\n") },
    { role: "user", content: userLines.join("\n") },
  ];

  const { content, inputTokens, outputTokens } = await callOpenRouter(apiKey, model, messages);

  recordSession({
    runId, targetId, stepId, model,
    inputTokens, outputTokens,
    prompt: userLines.join("\n"),
    generatedText: content,
  });

  const parsed = parseJsonBlock<{ subject?: string; body?: string }>(content);
  if (parsed?.subject && parsed?.body) {
    return { subject: parsed.subject.trim(), body: parsed.body.trim() };
  }

  // Fallback: treat first line as subject
  const lines = content.trim().split("\n");
  const subject = lines[0].replace(/^subject:\s*/i, "").trim();
  const body = lines.slice(1).join("\n").trim();
  return { subject, body: body || content.trim() };
}

export async function previewMessage(params: AnyRecord): Promise<{ body: string; subject?: string; inputTokens: number; outputTokens: number; costUsd: number }> {
  const {
    stepType, model, apiKey, targetId, stepPrompt, maxWords, language, campaignPrompt,
  } = params as {
    stepType: "message" | "sales_inmail" | "email";
    model: string; apiKey: string; targetId: string; stepPrompt: string;
    maxWords?: number | null; language?: string | null; campaignPrompt?: string | null;
  };

  const contactData = getContactWithCompany(targetId);
  if (!contactData) throw new Error("Contact not found");
  const agentConfig = getAgentConfig();
  const { contact, company } = contactData;

  const wordLimit = maxWords ? `Keep it under ${maxWords} words.` : "";
  const lang = language && language !== "English" ? `Write in ${language}.` : "";

  let messages: Array<{ role: string; content: string }>;
  let jsonResponse = false;

  if (stepType === "message") {
    const sys = [
      agentConfig.system_prompt?.trim() || "You are an expert B2B sales copywriter specialising in personalised LinkedIn outreach.",
      "Write messages that feel human and personal — never generic or template-like.",
      "Do NOT include greetings like 'Hi {{first_name}}' or sign-offs. Return only the message body.",
    ];
    const usr: string[] = ["Write a LinkedIn message to the following person.", "", "=== CONTACT INFO ===", buildContactBlock(contact, company)];
    if (campaignPrompt?.trim()) usr.push("", "=== CAMPAIGN CONTEXT ===", campaignPrompt.trim());
    if (agentConfig.user_prompt?.trim()) usr.push("", "=== GUIDELINES ===", agentConfig.user_prompt.trim());
    if (agentConfig.linkedin_examples?.trim()) usr.push("", "=== EXAMPLE MESSAGES ===", agentConfig.linkedin_examples.trim());
    if (stepPrompt?.trim()) usr.push("", "=== STEP INSTRUCTIONS ===", stepPrompt.trim());
    usr.push("", [wordLimit, lang, "Return only the message body text."].filter(Boolean).join(" "));
    messages = [{ role: "system", content: sys.join("\n") }, { role: "user", content: usr.join("\n") }];
  } else if (stepType === "sales_inmail") {
    jsonResponse = true;
    const sys = [
      agentConfig.system_prompt?.trim() || "You are an expert B2B sales copywriter specialising in LinkedIn Sales Navigator InMails.",
      "InMails reach non-connections — the subject line is critical to getting opened.",
      "Write concise, personalised messages that feel human. Avoid generic openers.",
    ];
    const usr: string[] = ["Write a LinkedIn Sales Navigator InMail (subject + body) to the following person.", "", "=== CONTACT INFO ===", buildContactBlock(contact, company)];
    if (campaignPrompt?.trim()) usr.push("", "=== CAMPAIGN CONTEXT ===", campaignPrompt.trim());
    if (agentConfig.user_prompt?.trim()) usr.push("", "=== GUIDELINES ===", agentConfig.user_prompt.trim());
    if (agentConfig.linkedin_examples?.trim()) usr.push("", "=== EXAMPLE MESSAGES ===", agentConfig.linkedin_examples.trim());
    if (stepPrompt?.trim()) usr.push("", "=== STEP INSTRUCTIONS ===", stepPrompt.trim());
    usr.push("", [wordLimit, lang].filter(Boolean).join(" "));
    usr.push('Return ONLY valid JSON in this exact format:', '{"subject": "<subject line>", "body": "<message body>"}');
    messages = [{ role: "system", content: sys.join("\n") }, { role: "user", content: usr.join("\n") }];
  } else {
    jsonResponse = true;
    const sys = [
      agentConfig.system_prompt?.trim() || "You are an expert B2B cold email copywriter writing personalised outreach emails.",
      "Emails should be short, specific, and value-focused. Avoid buzzwords and generic openers.",
      "Do NOT include salutations (Hi/Hello) or sign-offs — the caller handles those.",
    ];
    const usr: string[] = ["Write a personalised cold email to the following person.", "", "=== CONTACT INFO ===", buildContactBlock(contact, company)];
    if (campaignPrompt?.trim()) usr.push("", "=== CAMPAIGN CONTEXT ===", campaignPrompt.trim());
    if (agentConfig.user_prompt?.trim()) usr.push("", "=== GUIDELINES ===", agentConfig.user_prompt.trim());
    if (agentConfig.email_examples?.trim()) usr.push("", "=== EXAMPLE EMAILS ===", agentConfig.email_examples.trim());
    if (stepPrompt?.trim()) usr.push("", "=== STEP INSTRUCTIONS ===", stepPrompt.trim());
    usr.push("", [wordLimit, lang].filter(Boolean).join(" "));
    usr.push('Return ONLY valid JSON in this exact format:', '{"subject": "<email subject>", "body": "<email body>"}');
    messages = [{ role: "system", content: sys.join("\n") }, { role: "user", content: usr.join("\n") }];
  }

  const { content, inputTokens, outputTokens } = await callOpenRouter(apiKey, model, messages);
  const costUsd = estimateCost(model, inputTokens, outputTokens);

  if (jsonResponse) {
    const parsed = parseJsonBlock<{ subject?: string; body?: string }>(content);
    if (parsed?.body) return { body: parsed.body.trim(), subject: parsed.subject?.trim(), inputTokens, outputTokens, costUsd };
    const lines = content.trim().split("\n");
    return { body: lines.slice(1).join("\n").trim() || content.trim(), subject: lines[0].trim(), inputTokens, outputTokens, costUsd };
  }

  return { body: content.trim(), inputTokens, outputTokens, costUsd };
}

// Aggregate export satisfying AiSurface
export const ai: AiSurface = {
  getAgentConfig,
  getContactWithCompany,
  writeEmail,
  writeLinkedInMessage,
  writeSalesInMail,
  previewMessage,
};
