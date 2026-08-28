import type { Page } from "playwright";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { getSessionPage, saveSessionState, markNeedsReauth } from "@/lib/linkedin/session";
import { saveScreenshot } from "./screenshot";

// Withdraw oldest pending invitations to stay under LinkedIn's 200-invite cap.
// Triggers at 180 pending, drains to 150.
// Strategy: scroll sent-invitations page to bottom (lazy-loads oldest),
// then click the last N Withdraw buttons in DOM order (bottom = oldest).

const WITHDRAW_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TARGET_PENDING = 150;
const TRIGGER_PENDING = 180;

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

export async function withdrawOldestInvites(accountId: string, count?: number): Promise<number> {
  const db = getDb();
  const page = await getSessionPage(accountId);
  let withdrawn = 0;

  try {
    await page.goto("https://www.linkedin.com/mynetwork/invitation-manager/sent/", {
      waitUntil: "domcontentloaded",
      timeout: 35000,
    });
    await page.waitForTimeout(2500 + Math.random() * 1000);
    await saveScreenshot(page, "withdraw_invites_page");

    if (/\/login|\/authwall|\/checkpoint|\/uas\//.test(page.url())) {
      console.warn("[withdraw-invites] Session looks logged out — skipping");
      return 0;
    }

    // Scroll to bottom, triggering lazy-load of all invites (oldest at bottom)
    let prevHeight = 0;
    for (let i = 0; i < 60; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1200);
      const h = await page.evaluate(() => document.body.scrollHeight);
      if (h === prevHeight) break;
      prevHeight = h;
    }
    await saveScreenshot(page, "withdraw_scrolled_to_bottom");

    // Count all visible Withdraw buttons — each represents one pending invite
    const btnSel = '[aria-label*="Withdraw"]';
    const total = await page.locator(btnSel).count();
    console.log(`[withdraw-invites] ${total} pending, will withdraw ${count ?? Math.max(0, total - TARGET_PENDING)} oldest`);
    db.prepare("UPDATE accounts SET li_pending = ? WHERE id = ?").run(total, accountId);

    const toWithdraw = count ?? Math.max(0, total - TARGET_PENDING);
    if (toWithdraw === 0) return 0;

    // Withdraw from the bottom up (oldest first).
    // After each withdrawal the card disappears, so always re-query and take last.
    for (let i = 0; i < toWithdraw; i++) {
      try {
        const btns = page.locator(btnSel);
        const remCount = await btns.count();
        if (remCount === 0) break;

        const lastBtn = btns.nth(remCount - 1);

        // Extract profile URL from the card before clicking
        const profileUrl = await lastBtn.evaluate((el: Element) => {
          const card = el.closest("li, article, [data-view-name]") ?? el.parentElement?.parentElement;
          const link = card?.querySelector<HTMLAnchorElement>('a[href*="/in/"]');
          return link?.pathname ?? null;
        });

        await lastBtn.scrollIntoViewIfNeeded();
        await saveScreenshot(page, "withdraw_found_button");
        await lastBtn.click();
        await page.waitForTimeout(800);

        // Confirm dialog
        const confirmBtn = page.locator('dialog[open] button[aria-label*="Withdraw"], [role="dialog"] button[aria-label*="Withdraw"]').first();
        let ok = false;
        if (await confirmBtn.count() > 0) {
          await saveScreenshot(page, "withdraw_confirm_dialog");
          await confirmBtn.click();
          await page.waitForTimeout(1200);
          await saveScreenshot(page, "withdraw_confirmed");
          ok = true;
        } else {
          // Some cards withdraw without dialog; check if count dropped
          await page.waitForTimeout(600);
          const newCount = await page.locator(btnSel).count();
          ok = newCount < remCount;
          await saveScreenshot(page, ok ? "withdraw_confirmed_no_dialog" : "withdraw_no_dialog");
        }

        if (ok) {
          withdrawn++;
          if (profileUrl) {
            const vanity = profileUrl.replace(/^\/in\//, "").replace(/\/$/, "");
            const now = new Date().toISOString();
            db.prepare(
              "UPDATE targets SET connection_requested_at = NULL, connection_withdrawn_at = ? WHERE linkedin_url LIKE ?"
            ).run(now, `%/in/${vanity}%`);
            const t = db.prepare("SELECT id FROM targets WHERE linkedin_url LIKE ?").get(`%/in/${vanity}%`) as { id: string } | undefined;
            if (t) {
              db.prepare(
                "INSERT INTO activity_logs (id, target_id, type, body) VALUES (?, ?, 'other', ?)"
              ).run(randomUUID(), t.id, "Connection invite withdrawn (oldest pending — 3-week cooldown applied)");
            }
          }
          await page.waitForTimeout(800 + Math.random() * 600);
        }
      } catch (e) {
        console.warn("[withdraw-invites] Error during withdrawal:", e instanceof Error ? e.message : e);
      }
    }

    db.prepare("UPDATE accounts SET li_pending = ? WHERE id = ?").run(Math.max(0, total - withdrawn), accountId);
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
