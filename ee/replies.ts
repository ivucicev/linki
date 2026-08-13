import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";
import { getSessionPage, saveSessionState } from "@/lib/linkedin/session";
import { decryptSecret } from "@/lib/crypto";
import type { RepliesSurface } from "@/lib/premium";

const LINKEDIN_INBOX_SYNC_INTERVAL_MS = 15 * 60 * 1000; // 15 min

// ── LinkedIn inbox sync ───────────────────────────────────────────────────────

export function shouldSyncInbox(accountId: string): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT inbox_synced_at FROM accounts WHERE id = ?")
    .get(accountId) as { inbox_synced_at: string | null } | undefined;
  if (!row?.inbox_synced_at) return true;
  return Date.now() - new Date(row.inbox_synced_at).getTime() >= LINKEDIN_INBOX_SYNC_INTERVAL_MS;
}

interface ConversationParticipant {
  fsdUrn: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
}

interface Conversation {
  lastSenderFsdUrn: string | null;
  lastSenderName: string | null;
  lastActivityAt: number;
  participants: ConversationParticipant[];
  isSentByOther: boolean;
}

// Fetch recent conversations via the LinkedIn Voyager messaging API using the
// account's existing Playwright session. The page cookies provide authentication.
async function fetchRecentConversations(page: import("playwright").Page): Promise<Conversation[]> {
  return page.evaluate(async () => {
    const cookies = document.cookie.split("; ").reduce((acc: Record<string, string>, c) => {
      const i = c.indexOf("=");
      if (i > 0) acc[c.slice(0, i)] = c.slice(i + 1);
      return acc;
    }, {});
    const csrf = (cookies["JSESSIONID"] ?? "").replace(/"/g, "");

    // We need the viewer's own member URN to distinguish self-sent messages.
    // The global variable on LinkedIn pages holds this.
    const selfUrn: string = await new Promise((resolve) => {
      // Try to read the urn from global state (exposed by LinkedIn's shell)
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const g = window as any;
        const candidate =
          g?.voyagerIdentity?.miniProfile?.entityUrn ||
          g?.liap?.context?.memberUrn ||
          "";
        resolve(String(candidate));
      } catch {
        resolve("");
      }
    });

    let json: Record<string, unknown> | null = null;
    try {
      const r = await fetch(
        "https://www.linkedin.com/voyager/api/messaging/conversations?q=search&queryVersion=PRODUCTION&start=0&count=30",
        {
          headers: {
            "csrf-token": csrf,
            accept: "application/vnd.linkedin.normalized+json+2.1",
            "x-restli-protocol-version": "2.0.0",
            "x-li-lang": "en_US",
          },
          credentials: "include",
        },
      );
      if (!r.ok) return [];
      json = await r.json() as Record<string, unknown>;
    } catch {
      return [];
    }

    if (!json) return [];

    const included = (json.included as Array<Record<string, unknown>>) || [];

    // Index profiles and participants by URN
    const profileByUrn = new Map<string, { firstName: string; lastName: string; entityUrn: string }>();
    for (const x of included) {
      const type = String(x.$type ?? "");
      if (
        (type.includes("MiniProfile") || type.includes("miniProfile")) &&
        x.entityUrn &&
        (x.firstName || x.lastName)
      ) {
        profileByUrn.set(String(x.entityUrn), {
          entityUrn: String(x.entityUrn),
          firstName: String(x.firstName ?? ""),
          lastName: String(x.lastName ?? ""),
        });
      }
    }

    // Index events by URN
    const eventByUrn = new Map<string, { fromUrn: string; createdAt: number }>();
    for (const x of included) {
      const type = String(x.$type ?? "");
      if (type.includes("messaging.Event") && x.entityUrn) {
        // 'from' is a nested object with a 'messagingMember' or direct memberIdentity
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const from = x.from as any;
        const fromUrn =
          from?.["com.linkedin.voyager.messaging.MessagingMember"]?.memberIdentity ||
          from?.memberIdentity ||
          from?.entityUrn ||
          "";
        eventByUrn.set(String(x.entityUrn), {
          fromUrn: String(fromUrn),
          createdAt: Number(x.createdAt ?? 0),
        });
      }
    }

    // Resolve conversation elements
    const results: {
      lastSenderFsdUrn: string | null;
      lastSenderName: string | null;
      lastActivityAt: number;
      participants: { fsdUrn: string | null; firstName: string | null; lastName: string | null; fullName: string | null }[];
      isSentByOther: boolean;
    }[] = [];

    for (const x of included) {
      const type = String(x.$type ?? "");
      if (!type.includes("messaging.Conversation")) continue;

      const lastActivityAt = Number(x.lastActivityAt ?? 0);

      // Participant URNs
      const rawParticipants = (x["*participants"] as string[]) ?? [];
      const participants: typeof results[0]["participants"] = [];

      for (const pUrn of rawParticipants) {
        // Participants link to MiniProfiles via their own URN structure
        // Try matching the participant URN to a profile
        let profile = profileByUrn.get(pUrn) ?? null;
        if (!profile) {
          // Sometimes participant URNs have a different prefix — try to find by suffix
          for (const [urn, p] of profileByUrn) {
            if (pUrn.endsWith(urn) || urn.endsWith(pUrn)) {
              profile = p;
              break;
            }
          }
        }
        participants.push({
          fsdUrn: profile ? profile.entityUrn : null,
          firstName: profile ? profile.firstName : null,
          lastName: profile ? profile.lastName : null,
          fullName: profile ? `${profile.firstName} ${profile.lastName}`.trim() : null,
        });
      }

      // Find the last event's sender
      const eventUrns = (x["*events"] as string[]) ?? [];
      let lastSenderFsdUrn: string | null = null;
      let lastSenderName: string | null = null;
      let latestEventAt = 0;

      for (const eUrn of eventUrns) {
        const ev = eventByUrn.get(eUrn);
        if (!ev) continue;
        if (ev.createdAt > latestEventAt) {
          latestEventAt = ev.createdAt;
          lastSenderFsdUrn = ev.fromUrn || null;
        }
      }

      // Determine if the last sender is NOT us (the account owner)
      const isSentByOther = lastSenderFsdUrn
        ? !selfUrn || !lastSenderFsdUrn.includes(selfUrn.split(":").pop() ?? "NOMATCH")
        : false;

      // Resolve sender name
      if (lastSenderFsdUrn) {
        const p = profileByUrn.get(lastSenderFsdUrn);
        if (p) lastSenderName = `${p.firstName} ${p.lastName}`.trim();
      }
      if (!lastSenderName && participants.length > 0) {
        lastSenderName = participants.find((p) => p.fsdUrn === lastSenderFsdUrn)?.fullName ?? null;
      }

      results.push({ lastSenderFsdUrn, lastSenderName, lastActivityAt, participants, isSentByOther });
    }

    return results;
  }) as Promise<Conversation[]>;
}

export async function syncAccountInbox(accountId: string): Promise<number> {
  const db = getDb();
  const page = await getSessionPage(accountId);
  let detected = 0;

  try {
    // Navigate to messaging to ensure a valid session page context
    await page.goto("https://www.linkedin.com/messaging/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(2000 + Math.random() * 1000);

    // Bail out if we've hit a login/auth wall
    if (/\/login|\/authwall|\/checkpoint|\/uas\//.test(page.url())) {
      console.warn(`[linkedin-inbox] Session expired for account ${accountId} — skipping inbox sync`);
      return 0;
    }

    const conversations = await fetchRecentConversations(page);

    // Load targets that have been messaged on LinkedIn but haven't replied yet
    const pendingTargets = db.prepare(`
      SELECT t.id, t.full_name, t.messaging_urn, t.first_name, t.last_name
      FROM targets t
      JOIN run_profiles rp ON rp.target_id = t.id
      JOIN runs r ON r.id = rp.run_id
      WHERE t.message_sent_at IS NOT NULL
        AND t.last_replied_at IS NULL
        AND r.account_id = ?
        AND r.status IN ('running', 'paused')
    `).all(accountId) as Array<{
      id: string;
      full_name: string | null;
      messaging_urn: string | null;
      first_name: string | null;
      last_name: string | null;
    }>;

    if (pendingTargets.length === 0) {
      return 0;
    }

    const now = new Date().toISOString().replace("T", " ").slice(0, 19);

    for (const conv of conversations) {
      if (!conv.isSentByOther) continue;

      // Try to match a conversation participant to a known pending target
      // Priority 1: match by messaging_urn (fsd_profile URN)
      // Priority 2: match by full name
      let matchedTarget: (typeof pendingTargets)[0] | null = null;

      for (const participant of conv.participants) {
        if (!participant.fsdUrn && !participant.fullName) continue;

        for (const target of pendingTargets) {
          if (participant.fsdUrn && target.messaging_urn && participant.fsdUrn === target.messaging_urn) {
            matchedTarget = target;
            break;
          }
          // Fuzzy name match as fallback
          if (participant.fullName && target.full_name) {
            const normalize = (s: string) =>
              s.toLowerCase().normalize("NFKD").replace(/\p{Diacritic}/gu, "").trim();
            if (normalize(participant.fullName) === normalize(target.full_name)) {
              matchedTarget = target;
              break;
            }
          }
        }

        if (matchedTarget) break;
      }

      if (!matchedTarget) continue;

      db.prepare(`
        UPDATE targets
        SET last_replied_at = COALESCE(last_replied_at, ?)
        WHERE id = ?
      `).run(now, matchedTarget.id);

      console.log(`[linkedin-inbox] Reply detected from ${matchedTarget.full_name} (${matchedTarget.id})`);
      detected++;
    }
  } finally {
    try { await page.close(); } catch { /* ignore */ }
    try { await saveSessionState(accountId); } catch { /* ignore */ }
    db.prepare("UPDATE accounts SET inbox_synced_at = datetime('now') WHERE id = ?").run(accountId);
  }

  return detected;
}

// ── Email reply classification ─────────────────────────────────────────────────

type ReplyKind = "ooo" | "human_reply" | "not_interested" | "call_task";

interface ClassificationResult {
  type: ReplyKind;
  confidence: number;
  notes: string;
}

function parseJsonBlock<T>(text: string): T | null {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  try { return JSON.parse(cleaned) as T; } catch { /* continue */ }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]) as T; } catch { /* continue */ } }
  return null;
}

async function classifyReply(
  apiKey: string,
  model: string,
  senderName: string,
  subject: string | null,
  body: string,
): Promise<ClassificationResult | null> {
  const systemPrompt = `You are an expert at classifying sales email replies.
Classify the following email reply into one of these categories:
- "ooo": Out-of-office or automated auto-reply
- "human_reply": A genuine human response (positive, neutral, or asking for more info)
- "not_interested": Explicit rejection, unsubscribe request, or negative response
- "call_task": The person wants to schedule a call, demo, or meeting

Return ONLY valid JSON: {"type": "<category>", "confidence": <0.0-1.0>, "notes": "<brief reason>"}`;

  const userPrompt = [
    `From: ${senderName}`,
    subject ? `Subject: ${subject}` : "",
    "",
    body.slice(0, 3000),
  ].filter(Boolean).join("\n");

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://linki.app",
      "X-Title": "Linki",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
    }),
  });

  if (!resp.ok) return null;

  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = data.choices?.[0]?.message?.content ?? "";
  return parseJsonBlock<ClassificationResult>(content);
}

export async function classifyAndDispatch(replyId: string): Promise<void> {
  const db = getDb();

  const reply = db.prepare(`
    SELECT er.*, t.full_name, t.company
    FROM email_replies er
    LEFT JOIN targets t ON t.id = er.target_id
    WHERE er.id = ?
  `).get(replyId) as {
    id: string;
    target_id: string;
    run_id: string | null;
    from_email: string;
    subject: string | null;
    body_text: string;
    classified_at: string | null;
    full_name: string | null;
    company: string | null;
  } | undefined;

  if (!reply) return;
  if (reply.classified_at) return; // already processed

  const integration = db.prepare(
    "SELECT api_key FROM integrations WHERE key = 'openrouter'",
  ).get() as { api_key: string } | undefined;

  const agentCfg = db.prepare("SELECT default_model FROM agent_config WHERE id = 1").get() as
    { default_model: string | null } | undefined;

  const apiKey = integration?.api_key ? decryptSecret(integration.api_key) : null;
  const model = agentCfg?.default_model;

  let classification: ClassificationResult | null = null;

  if (apiKey && model) {
    try {
      classification = await classifyReply(
        apiKey,
        model,
        reply.full_name ?? reply.from_email,
        reply.subject,
        reply.body_text,
      );
    } catch (err) {
      console.warn(`[replies] Classification failed for reply ${replyId}:`, err);
      db.prepare(`
        UPDATE email_replies SET classified_at = datetime('now'), classification_error = ? WHERE id = ?
      `).run(String(err), replyId);
      return;
    }
  } else {
    // No AI available — default to human_reply so the contact isn't left in limbo
    classification = { type: "human_reply", confidence: 0, notes: "No AI configured — defaulted to human_reply" };
  }

  if (!classification) {
    db.prepare(`
      UPDATE email_replies SET classified_at = datetime('now'), classification_error = 'Parse failed' WHERE id = ?
    `).run(replyId);
    return;
  }

  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const classJson = JSON.stringify(classification);

  db.prepare(`
    UPDATE email_replies
    SET classified_at = datetime('now'), classification_json = ?
    WHERE id = ?
  `).run(classJson, replyId);

  let dispatchResult: string;

  switch (classification.type) {
    case "ooo": {
      // Store the OOO body as context for the next AI email — runner will use it and clear it.
      // Find the active email track for this target in this run.
      if (reply.run_id) {
        db.prepare(`
          UPDATE run_profile_tracks
          SET pending_reply_context = ?
          WHERE run_profile_id IN (SELECT id FROM run_profiles WHERE run_id = ? AND target_id = ?)
            AND track = 'email'
            AND state IN ('pending', 'in_progress')
        `).run(reply.body_text.slice(0, 2000), reply.run_id, reply.target_id);
      }
      dispatchResult = "ooo — pending_reply_context set, track continues";
      break;
    }

    case "not_interested": {
      db.prepare(`
        UPDATE targets
        SET email_replied_at = COALESCE(email_replied_at, ?),
            last_replied_at  = COALESCE(last_replied_at, ?),
            reply_kind       = COALESCE(reply_kind, 'not_interested')
        WHERE id = ?
      `).run(now, now, reply.target_id);

      // Skip the email track
      if (reply.run_id) {
        db.prepare(`
          UPDATE run_profile_tracks
          SET state = 'skipped', error_message = 'Replied: not interested'
          WHERE run_profile_id IN (SELECT id FROM run_profiles WHERE run_id = ? AND target_id = ?)
            AND track = 'email'
            AND state IN ('pending', 'in_progress')
        `).run(reply.run_id, reply.target_id);
      }
      dispatchResult = "not_interested — track skipped, target stamped";
      break;
    }

    case "call_task": {
      db.prepare(`
        UPDATE targets
        SET email_replied_at = COALESCE(email_replied_at, ?),
            last_replied_at  = COALESCE(last_replied_at, ?),
            reply_kind       = COALESCE(reply_kind, 'call_task')
        WHERE id = ?
      `).run(now, now, reply.target_id);

      // Create a CRM todo for the sales rep
      const taskTitle = `Call / demo with ${reply.full_name ?? reply.from_email}`;
      db.prepare(`
        INSERT INTO todos (id, target_id, title, status)
        VALUES (?, ?, ?, 'open')
      `).run(randomUUID(), reply.target_id, taskTitle);

      // Skip the email track (task created — hand off to human)
      if (reply.run_id) {
        db.prepare(`
          UPDATE run_profile_tracks
          SET state = 'skipped', error_message = 'Replied: call/demo requested — todo created'
          WHERE run_profile_id IN (SELECT id FROM run_profiles WHERE run_id = ? AND target_id = ?)
            AND track = 'email'
            AND state IN ('pending', 'in_progress')
        `).run(reply.run_id, reply.target_id);
      }
      dispatchResult = "call_task — todo created, track skipped";
      break;
    }

    case "human_reply":
    default: {
      db.prepare(`
        UPDATE targets
        SET email_replied_at = COALESCE(email_replied_at, ?),
            last_replied_at  = COALESCE(last_replied_at, ?),
            reply_kind       = COALESCE(reply_kind, 'human_reply')
        WHERE id = ?
      `).run(now, now, reply.target_id);
      dispatchResult = "human_reply — target stamped, track continues";
      break;
    }
  }

  db.prepare(`
    UPDATE email_replies
    SET dispatched_at = datetime('now'), dispatch_result_json = ?
    WHERE id = ?
  `).run(JSON.stringify({ result: dispatchResult }), replyId);

  console.log(`[replies] ${replyId}: ${classification.type} (${Math.round(classification.confidence * 100)}%) — ${dispatchResult}`);
}

export const replies: RepliesSurface = {
  shouldSyncInbox,
  syncAccountInbox,
  classifyAndDispatch,
};
