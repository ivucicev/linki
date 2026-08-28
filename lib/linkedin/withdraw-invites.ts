import type { Page, Response as PlaywrightResponse } from "playwright";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { getSessionPage, saveSessionState, markNeedsReauth } from "@/lib/linkedin/session";
import { saveScreenshot } from "./screenshot";

// Withdraw oldest pending invitations to stay under LinkedIn's 200-invite cap.
// Triggers at 180 pending, drains to 150 (withdraws the difference).
// Intercepts LinkedIn's own Voyager API calls during page load to discover
// the correct endpoint URL, then paginates from the browser context.

const WITHDRAW_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TARGET_PENDING = 150;  // drain to this
const TRIGGER_PENDING = 180; // fire when >= this

export function shouldWithdrawInvites(accountId: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT withdraw_invites_at, li_pending FROM accounts WHERE id = ?").get(accountId) as
    | { withdraw_invites_at: string | null; li_pending: number | null }
    | undefined;
  if (!row) return false;
  if (row.li_pending !== null && row.li_pending < TRIGGER_PENDING) return false;
  if (!row.withdraw_invites_at) return true;
  return Date.now() - new Date(row.withdraw_invites_at).getTime() >= WITHDRAW_INTERVAL_MS;
}

interface PendingInvite {
  entityUrn: string;
  inviteeProfileUrl: string | null;
  sentAt: number;
}

export async function withdrawOldestInvites(accountId: string, count?: number): Promise<number> {
  const db = getDb();
  const page = await getSessionPage(accountId);
  let withdrawn = 0;

  try {
    // Intercept Voyager API responses BEFORE navigating so we capture the real URL
    const invites = await navigateAndFetchInvites(page);

    await saveScreenshot(page, "withdraw_invites_page");

    if (/\/login|\/authwall|\/checkpoint|\/uas\//.test(page.url())) {
      console.warn("[withdraw-invites] Session looks logged out — skipping");
      return 0;
    }

    if (!invites) {
      console.warn("[withdraw-invites] Could not fetch pending invites — skipping");
      return 0;
    }

    // Withdraw enough to bring pending to TARGET_PENDING, or caller-specified count
    const toWithdraw = count ?? Math.max(0, invites.length - TARGET_PENDING);
    const oldest = [...invites].sort((a, b) => a.sentAt - b.sentAt).slice(0, toWithdraw);
    console.log(`[withdraw-invites] ${invites.length} pending, withdrawing ${oldest.length} oldest`);

    for (const invite of oldest) {
      try {
        // Look up targetId for screenshot tagging
        let targetId: string | undefined;
        if (invite.inviteeProfileUrl) {
          const vanity = invite.inviteeProfileUrl.replace(/^\/in\//, "").replace(/\/$/, "");
          const t = db.prepare("SELECT id FROM targets WHERE linkedin_url LIKE ?").get(`%/in/${vanity}%`) as { id: string } | undefined;
          targetId = t?.id;
        }

        const ok = await withdrawOneOnPage(page, invite.entityUrn, invite.inviteeProfileUrl, targetId);
        if (ok) {
          withdrawn++;
          if (invite.inviteeProfileUrl) {
            const vanity = invite.inviteeProfileUrl.replace(/^\/in\//, "").replace(/\/$/, "");
            const now = new Date().toISOString();
            db.prepare(
              "UPDATE targets SET connection_requested_at = NULL, connection_withdrawn_at = ? WHERE linkedin_url LIKE ?"
            ).run(now, `%/in/${vanity}%`);
            if (targetId) {
              db.prepare(
                "INSERT INTO activity_logs (id, target_id, type, body) VALUES (?, ?, 'other', ?)"
              ).run(randomUUID(), targetId, "Connection invite withdrawn (oldest pending — 3-week cooldown applied)");
            }
          }
          await page.waitForTimeout(1200 + Math.random() * 800);
        }
      } catch (e) {
        console.warn("[withdraw-invites] Failed to withdraw:", e instanceof Error ? e.message : e);
      }
    }

    db.prepare("UPDATE accounts SET li_pending = ? WHERE id = ?").run(invites.length - withdrawn, accountId);
  } finally {
    let url = "";
    try { url = page.url(); } catch { /* gone */ }
    try { await page.close(); } catch { /* ignore */ }
    if (/\/login|\/authwall|\/checkpoint|\/uas\//.test(url)) {
      try { await markNeedsReauth(accountId); } catch { /* ignore */ }
    } else {
      try { await saveSessionState(accountId); } catch { /* ignore */ }
    }
    db.prepare("UPDATE accounts SET withdraw_invites_at = datetime('now') WHERE id = ?").run(accountId);
  }

  return withdrawn;
}

// Navigate to the sent invitations page and intercept LinkedIn's own Voyager calls
// to discover the correct endpoint URL + parse all pages of pending invites.
async function navigateAndFetchInvites(page: Page): Promise<PendingInvite[] | null> {
  const all: PendingInvite[] = [];
  let capturedApiBase: string | null = null;
  let capturedParams: Record<string, string> = {};
  let capturedCsrf: string | null = null;

  const onResponse = async (response: PlaywrightResponse) => {
    try {
      const url = response.url();
      if (!url.includes("/voyager/api/")) return;
      if (!url.toLowerCase().includes("invitation")) return;
      if (response.status() !== 200) return;

      // Capture the real URL LinkedIn uses
      const parsed = new URL(url);
      if (!capturedApiBase) {
        capturedApiBase = `${parsed.origin}${parsed.pathname}`;
        capturedParams = Object.fromEntries(parsed.searchParams.entries());
        const reqHeaders = await response.request().allHeaders();
        capturedCsrf = reqHeaders["csrf-token"] ?? reqHeaders["csrf-token".toLowerCase()] ?? null;
        console.log(`[withdraw-invites] Intercepted Voyager URL: ${capturedApiBase} params: ${JSON.stringify(capturedParams)} csrf: ${capturedCsrf ? "yes" : "no"}`);
      }

      const json = await response.json() as Record<string, unknown>;
      parseInviteResponse(json, all);
    } catch (e) {
      console.warn("[withdraw-invites] Response intercept error:", e instanceof Error ? e.message : e);
    }
  };

  page.on("response", onResponse);

  await page.goto("https://www.linkedin.com/mynetwork/invitation-manager/sent/", {
    waitUntil: "domcontentloaded",
    timeout: 35000,
  });
  // Wait for the async API calls to complete
  await page.waitForTimeout(3500);

  page.off("response", onResponse);

  if (!capturedApiBase || !capturedCsrf) {
    console.warn(`[withdraw-invites] Did not intercept Voyager call. base=${capturedApiBase} csrf=${capturedCsrf}`);
    // Return what we got (may be empty)
    return all.length > 0 ? all : null;
  }

  // Paginate: fetch additional pages from browser context using captured URL + CSRF
  const pageCount = parseInt(capturedParams.count ?? "20");
  let start = pageCount; // page 0 already captured via interception

  if (all.length >= pageCount) {
    const moreInvites = await page.evaluate(
      async ({ apiBase, params, csrf, startAt, perPage }: { apiBase: string; params: Record<string, string>; csrf: string; startAt: number; perPage: number }) => {
        const results: Array<{ entityUrn: string; inviteeProfileUrl: string | null; sentAt: number }> = [];

        for (let pg = 0; pg < 10; pg++) {
          const p = new URLSearchParams(params);
          p.set("start", String(startAt + pg * perPage));
          let json: Record<string, unknown>;
          try {
            const r = await fetch(`${apiBase}?${p.toString()}`, {
              headers: {
                "csrf-token": csrf,
                "accept": "application/vnd.linkedin.normalized+json+2.1",
                "x-restli-protocol-version": "2.0.0",
                "x-li-lang": "en_US",
              },
              credentials: "include",
            });
            if (!r.ok) break;
            json = await r.json() as Record<string, unknown>;
          } catch { break; }

          const candidates = (json.included ?? json.elements ?? (json.data as Record<string,unknown>)?.elements ?? []) as Record<string, unknown>[];
          let added = 0;
          for (const x of candidates) {
            const urn = (x.entityUrn ?? x.invitationUrn) as string | undefined;
            if (!urn) continue;
            const type = ((x["$type"] ?? x.type ?? "") as string).toLowerCase();
            if (!type.includes("invitation")) continue;
            const sentRaw = (x.sentTime ?? x.createdAt ?? x.sentAt) as number | string | undefined;
            const sentAt = typeof sentRaw === "number" ? sentRaw : sentRaw ? new Date(sentRaw as string).getTime() : Date.now();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const inv = x.invitee as any;
            const vanity: string | null =
              inv?.com_linkedin_voyager_identity_shared_MiniProfile?.publicIdentifier ??
              inv?.miniProfile?.publicIdentifier ??
              inv?.publicIdentifier ??
              (x.inviteePublicIdentifier as string | undefined) ??
              null;
            results.push({ entityUrn: urn, inviteeProfileUrl: vanity ? `/in/${vanity}` : null, sentAt });
            added++;
          }
          if (added === 0 || candidates.length < perPage) break;
        }
        return results;
      },
      { apiBase: capturedApiBase, params: capturedParams, csrf: capturedCsrf, startAt: start, perPage: pageCount }
    );
    all.push(...moreInvites);
  }

  return all;
}

function parseInviteResponse(json: Record<string, unknown>, out: PendingInvite[]): void {
  const candidates = (json.included ?? json.elements ?? (json.data as Record<string, unknown>)?.elements ?? []) as Record<string, unknown>[];
  for (const x of candidates) {
    const urn = (x.entityUrn ?? x.invitationUrn) as string | undefined;
    if (!urn) continue;
    const type = ((x["$type"] ?? x.type ?? "") as string).toLowerCase();
    if (!type.includes("invitation")) continue;
    const sentRaw = (x.sentTime ?? x.createdAt ?? x.sentAt) as number | string | undefined;
    const sentAt = typeof sentRaw === "number" ? sentRaw : sentRaw ? new Date(sentRaw as string).getTime() : Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inv = x.invitee as any;
    const vanity: string | null =
      inv?.com_linkedin_voyager_identity_shared_MiniProfile?.publicIdentifier ??
      inv?.miniProfile?.publicIdentifier ??
      inv?.publicIdentifier ??
      (x.inviteePublicIdentifier as string | undefined) ??
      null;
    out.push({ entityUrn: urn, inviteeProfileUrl: vanity ? `/in/${vanity}` : null, sentAt });
  }
}

async function withdrawOneOnPage(
  page: Page,
  entityUrn: string,
  profileUrl: string | null,
  targetId?: string
): Promise<boolean> {
  await page.goto("https://www.linkedin.com/mynetwork/invitation-manager/sent/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForTimeout(1500);

  const memberId = entityUrn.split(":").pop() ?? "";
  let found = false;

  for (let scroll = 0; scroll < 20 && !found; scroll++) {
    const withdrawBtn = page.locator(`a[componentkey*="${memberId}"][aria-label*="Withdraw"]`).first();
    if (await withdrawBtn.count() > 0) {
      await withdrawBtn.scrollIntoViewIfNeeded();
      await saveScreenshot(page, "withdraw_found_button", targetId);
      await withdrawBtn.click();
      await page.waitForTimeout(800);

      const confirmBtn = page.locator('dialog[open] button[aria-label*="Withdraw"]').first();
      if (await confirmBtn.count() > 0) {
        await saveScreenshot(page, "withdraw_confirm_dialog", targetId);
        await confirmBtn.click();
        await page.waitForTimeout(1000);
        await saveScreenshot(page, "withdraw_confirmed", targetId);
      } else {
        await saveScreenshot(page, "withdraw_no_dialog", targetId);
      }
      found = true;
    } else {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1200);
    }
  }

  if (!found) await saveScreenshot(page, "withdraw_not_found", targetId);
  return found;
}
