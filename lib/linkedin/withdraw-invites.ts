import type { Page } from "playwright";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { getSessionPage, saveSessionState, markNeedsReauth } from "@/lib/linkedin/session";
import { saveScreenshot } from "./screenshot";

// Withdraw oldest pending invitations to stay under LinkedIn's 200-invite cap.
// Triggers at 180 pending, drains to 150 (withdraws the difference).
// Uses Voyager API to list all pending invites without DOM scrolling,
// then DOM to click Withdraw + confirm dialog per invite.

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
    await page.goto("https://www.linkedin.com/mynetwork/invitation-manager/sent/", {
      waitUntil: "domcontentloaded",
      timeout: 35000,
    });
    await page.waitForTimeout(2500 + Math.random() * 1500);
    await saveScreenshot(page, "withdraw_invites_page");

    if (/\/login|\/authwall|\/checkpoint|\/uas\//.test(page.url())) {
      console.warn("[withdraw-invites] Session looks logged out — skipping");
      return 0;
    }

    const invites = await fetchSentInvites(page);
    if (!invites) {
      console.warn("[withdraw-invites] Voyager API failed — skipping");
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

async function fetchSentInvites(page: Page): Promise<PendingInvite[] | null> {
  return page.evaluate(async (): Promise<PendingInvite[] | null> => {
    const cookies = document.cookie.split("; ").reduce((a: Record<string, string>, c) => {
      const i = c.indexOf("=");
      if (i > 0) a[c.slice(0, i)] = c.slice(i + 1);
      return a;
    }, {});
    const csrf = (cookies["JSESSIONID"] || "").replace(/"/g, "");
    const all: Array<{ entityUrn: string; inviteeProfileUrl: string | null; sentAt: number }> = [];
    let start = 0;
    const count = 100;

    for (let pg = 0; pg < 5; pg++) {
      let json: {
        included?: Array<{
          $type?: string;
          entityUrn?: string;
          sentTime?: number;
          invitee?: { com_linkedin_voyager_identity_shared_MiniProfile?: { publicIdentifier?: string } };
        }>;
      };
      try {
        const r = await fetch(
          `https://www.linkedin.com/voyager/api/relationships/sentInvitation/v2?start=${start}&count=${count}&sortType=DATE_CREATED`,
          {
            headers: {
              "csrf-token": csrf,
              "accept": "application/vnd.linkedin.normalized+json+2.1",
              "x-restli-protocol-version": "2.0.0",
              "x-li-lang": "en_US",
            },
            credentials: "include",
          }
        );
        if (!r.ok) break;
        json = await r.json();
      } catch {
        break;
      }

      const included = json.included ?? [];
      let foundAny = false;
      for (const x of included) {
        if (x.entityUrn && (x.$type ?? "").toLowerCase().includes("invitation") && typeof x.sentTime === "number") {
          foundAny = true;
          const vanity = x.invitee?.com_linkedin_voyager_identity_shared_MiniProfile?.publicIdentifier ?? null;
          all.push({ entityUrn: x.entityUrn, inviteeProfileUrl: vanity ? `/in/${vanity}` : null, sentAt: x.sentTime });
        }
      }
      if (!foundAny || included.length < count) break;
      start += count;
    }

    return all;
  });
}
