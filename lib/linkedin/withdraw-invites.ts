import type { Page } from "playwright";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { getSessionPage, saveSessionState, markNeedsReauth } from "@/lib/linkedin/session";
import { saveScreenshot } from "./screenshot";

// Withdraw oldest N pending sent invitations to stay under the 200-invite cap.
// Uses Voyager API to list pending invites (no DOM scroll needed), then DOM to
// click Withdraw + confirm for each.

const WITHDRAW_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day
const WITHDRAW_PER_DAY = 30;
const PENDING_THRESHOLD = 150; // only withdraw if pending count >= this

export function shouldWithdrawInvites(accountId: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT withdraw_invites_at, li_pending FROM accounts WHERE id = ?").get(accountId) as
    | { withdraw_invites_at: string | null; li_pending: number | null }
    | undefined;
  if (!row) return false;
  // Only bother if we know pending is high
  if (row.li_pending !== null && row.li_pending < PENDING_THRESHOLD) return false;
  if (!row.withdraw_invites_at) return true;
  return Date.now() - new Date(row.withdraw_invites_at).getTime() >= WITHDRAW_INTERVAL_MS;
}

interface PendingInvite {
  entityUrn: string;
  inviteeProfileUrl: string | null; // /in/vanity
  sentAt: number; // epoch ms
}

export async function withdrawOldestInvites(accountId: string, count = WITHDRAW_PER_DAY): Promise<number> {
  const db = getDb();
  const page = await getSessionPage(accountId);
  let withdrawn = 0;

  try {
    // Navigate to sent invitations page (establishes cookies for Voyager fetch)
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

    // Fetch pending invites via Voyager API (sorted oldest first by fetching all then reversing)
    const invites = await fetchSentInvites(page);
    if (!invites) {
      console.warn("[withdraw-invites] Voyager API failed — skipping");
      return 0;
    }

    // Sort oldest first, take the ones to withdraw
    const oldest = [...invites].sort((a, b) => a.sentAt - b.sentAt).slice(0, count);
    console.log(`[withdraw-invites] ${invites.length} pending, withdrawing ${oldest.length} oldest`);

    for (const invite of oldest) {
      try {
        // Navigate to their profile where the Withdraw button is accessible
        // OR use the invitation manager page and find by aria-label
        const withdrawn_ok = await withdrawOneOnPage(page, invite.entityUrn, invite.inviteeProfileUrl);
        if (withdrawn_ok) {
          withdrawn++;
          // Mark withdrawn in DB — clears pending, sets cooldown, logs activity
          if (invite.inviteeProfileUrl) {
            const vanity = invite.inviteeProfileUrl.replace(/^\/in\//, "").replace(/\/$/, "");
            const now = new Date().toISOString();
            const affected = db.prepare(
              "UPDATE targets SET connection_requested_at = NULL, connection_withdrawn_at = ? WHERE linkedin_url LIKE ?"
            ).run(now, `%/in/${vanity}%`);
            if (affected.changes > 0) {
              const target = db.prepare("SELECT id FROM targets WHERE linkedin_url LIKE ?").get(`%/in/${vanity}%`) as { id: string } | undefined;
              if (target) {
                db.prepare(
                  "INSERT INTO activity_logs (id, target_id, type, body) VALUES (?, ?, 'other', ?)"
                ).run(randomUUID(), target.id, "Connection invite withdrawn (oldest pending — 3-week cooldown applied)");
              }
            }
          }
          await page.waitForTimeout(1200 + Math.random() * 800);
        }
      } catch (e) {
        console.warn("[withdraw-invites] Failed to withdraw invite:", e instanceof Error ? e.message : e);
      }
    }

    // Update li_pending count
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

async function withdrawOneOnPage(page: Page, entityUrn: string, profileUrl: string | null): Promise<boolean> {
  // Use the invitation manager page — find the withdraw link by its componentkey (entityUrn encoded)
  // Simpler: find by aria-label containing the person's name isn't reliable, so navigate to
  // invitation manager and click Withdraw for the specific invite URN via the data attribute.
  // Fallback: scroll invitation manager and find by visible Withdraw links.

  await page.goto("https://www.linkedin.com/mynetwork/invitation-manager/sent/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForTimeout(1500);

  // The withdraw link has aria-label="Withdraw invitation sent to [Name]"
  // We identify the right one via the componentkey which encodes the member URN.
  // entityUrn example: "urn:li:member:123456" or "urn:li:fsd_profile:ACoAA..."
  // componentkey on the withdraw <a>: "ConnectButtonstate:invitation:urn:li:member:123456_pending" or similar

  // Scroll down to find and load the item — for old invites we need to scroll
  let found = false;
  for (let scroll = 0; scroll < 15 && !found; scroll++) {
    // Try to find withdraw button whose componentkey contains the member ID from the URN
    const memberId = entityUrn.split(":").pop() ?? "";
    const withdrawBtn = page.locator(`a[componentkey*="${memberId}"][aria-label*="Withdraw"]`).first();
    if (await withdrawBtn.count() > 0) {
      await withdrawBtn.scrollIntoViewIfNeeded();
      await saveScreenshot(page, "withdraw_found_button");
      await withdrawBtn.click();
      await page.waitForTimeout(800);

      // Confirm dialog
      const confirmBtn = page.locator('dialog[open] button[aria-label*="Withdraw"]').first();
      if (await confirmBtn.count() > 0) {
        await saveScreenshot(page, "withdraw_confirm_dialog");
        await confirmBtn.click();
        await page.waitForTimeout(1000);
        await saveScreenshot(page, "withdraw_confirmed");
        found = true;
      } else {
        // Dialog didn't open — already withdrawn or error
        found = true;
      }
    } else {
      // Scroll down to load more
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1200);
    }
  }

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

    for (let page = 0; page < 5; page++) { // max 500 invites
      let json: {
        included?: Array<{
          $type?: string;
          entityUrn?: string;
          sentTime?: number;
          invitation?: string;
          inviteeProfileUrl?: string;
          invitee?: { com_linkedin_voyager_identity_shared_MiniProfile?: { publicIdentifier?: string } };
        }>;
        data?: { paging?: { total?: number } };
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
          all.push({
            entityUrn: x.entityUrn,
            inviteeProfileUrl: vanity ? `/in/${vanity}` : null,
            sentAt: x.sentTime,
          });
        }
      }
      if (!foundAny || included.length < count) break;
      start += count;
    }

    return all;
  });
}
