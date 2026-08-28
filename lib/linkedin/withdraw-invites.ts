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

    // Scroll until no new Withdraw buttons appear (lazy-load complete).
    // Using button count as termination — more reliable than page height
    // because height updates before content renders, causing early exits.
    const btnSel = '[aria-label*="Withdraw"]';
    let prevCount = -1;
    let stableRounds = 0;
    for (let i = 0; i < 100; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2000);
      const curCount = await page.locator(btnSel).count();
      console.log(`[withdraw-invites] Scroll ${i + 1}: ${curCount} buttons`);
      if (curCount === prevCount) {
        stableRounds++;
        if (stableRounds >= 2) break; // stable for 2 rounds = truly at bottom
      } else {
        stableRounds = 0;
      }
      prevCount = curCount;
    }
    await saveScreenshot(page, "withdraw_scrolled_to_bottom");

    // Extract date from each card to ensure we withdraw truly oldest, not just last in DOM.
    // LinkedIn shows "Sent X days/weeks ago" text in each card.
    interface CardData { profileUrl: string | null; daysAgo: number; btnIndex: number; }
    const cardData = await page.evaluate((sel: string): CardData[] => {
      const btns = Array.from(document.querySelectorAll(sel));
      return btns.map((btn, idx) => {
        const card = btn.closest("li, article, [data-view-name]") ?? btn.parentElement?.parentElement ?? btn.parentElement;
        const link = card?.querySelector<HTMLAnchorElement>('a[href*="/in/"]');
        const profileUrl = link?.pathname ?? null;
        // Parse "Sent X days/weeks/months ago" — also check <time datetime>
        let daysAgo = 9999;
        const timeEl = card?.querySelector<HTMLTimeElement>("time[datetime]");
        if (timeEl?.dateTime) {
          const ms = Date.now() - new Date(timeEl.dateTime).getTime();
          daysAgo = ms / 86400000;
        } else {
          const text = card?.textContent ?? "";
          const m = text.match(/(\d+)\s+(day|week|month|year)s?\s+ago/i);
          if (m) {
            const n = parseInt(m[1]);
            const unit = m[2].toLowerCase();
            daysAgo = unit === "day" ? n : unit === "week" ? n * 7 : unit === "month" ? n * 30 : n * 365;
          }
        }
        return { profileUrl, daysAgo, btnIndex: idx };
      });
    }, btnSel);

    const total = cardData.length;
    // Sort oldest first (highest daysAgo)
    const oldest = [...cardData].sort((a, b) => b.daysAgo - a.daysAgo);
    const toWithdraw = count ?? Math.max(0, total - TARGET_PENDING);
    console.log(`[withdraw-invites] ${total} loaded, withdrawing ${toWithdraw} oldest (most recent of those: ${oldest[toWithdraw - 1]?.daysAgo?.toFixed(0)} days ago)`);
    db.prepare("UPDATE accounts SET li_pending = ? WHERE id = ?").run(total, accountId);
    if (toWithdraw === 0) return 0;

    // Withdraw each oldest card. Re-query each iteration since DOM shifts after removal.
    for (let i = 0; i < toWithdraw; i++) {
      try {
        // Re-extract to get current DOM state (indices shift after each withdrawal)
        const current = await page.evaluate((sel: string): CardData[] => {
          const btns = Array.from(document.querySelectorAll(sel));
          return btns.map((btn, idx) => {
            const card = btn.closest("li, article, [data-view-name]") ?? btn.parentElement?.parentElement ?? btn.parentElement;
            const link = card?.querySelector<HTMLAnchorElement>('a[href*="/in/"]');
            const profileUrl = link?.pathname ?? null;
            let daysAgo = 9999;
            const timeEl = card?.querySelector<HTMLTimeElement>("time[datetime]");
            if (timeEl?.dateTime) {
              const ms = Date.now() - new Date(timeEl.dateTime).getTime();
              daysAgo = ms / 86400000;
            } else {
              const text = card?.textContent ?? "";
              const m = text.match(/(\d+)\s+(day|week|month|year)s?\s+ago/i);
              if (m) {
                const n = parseInt(m[1]);
                const unit = m[2].toLowerCase();
                daysAgo = unit === "day" ? n : unit === "week" ? n * 7 : unit === "month" ? n * 30 : n * 365;
              }
            }
            return { profileUrl, daysAgo, btnIndex: idx };
          });
        }, btnSel);

        if (current.length === 0) break;
        // Pick the oldest remaining card
        const target = [...current].sort((a, b) => b.daysAgo - a.daysAgo)[0];
        const profileUrl = target.profileUrl;

        const btns = page.locator(btnSel);
        const btn = btns.nth(target.btnIndex);

        await btn.scrollIntoViewIfNeeded();
        await saveScreenshot(page, "withdraw_found_button");
        await btn.click();
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
          ok = newCount < current.length;
          await saveScreenshot(page, ok ? "withdraw_confirmed_no_dialog" : "withdraw_no_dialog");
        }

        if (ok) {
          withdrawn++;
          console.log(`[withdraw-invites] Withdrew #${withdrawn}, profileUrl=${profileUrl ?? "null"}`);
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
            } else {
              console.warn(`[withdraw-invites] No target found for vanity: ${vanity}`);
            }
          } else {
            console.warn("[withdraw-invites] No profile URL found in card — activity log skipped");
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
