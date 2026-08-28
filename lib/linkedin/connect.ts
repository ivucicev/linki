import type { Page } from "playwright";

export class WeeklyLimitError extends Error {}
export class AlreadyConnectedError extends Error {}
export class PendingInviteError extends Error {}

/**
 * Sends a LinkedIn connection request without a note.
 * All selectors scoped to the profile top card (main section containing h1/h2)
 * to prevent accidentally clicking sidebar "People you may know" Connect buttons.
 */
export async function sendConnectionRequest(page: Page, linkedinUrl: string): Promise<void> {
  await page.goto(linkedinUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000 + Math.random() * 1000);

  // Scope all checks to the profile's own top card — avoids sidebar "People you may know"
  // cards which also render Connect/Pending/Message buttons and caused ghost requests (Jul 2026).
  const topCard = page.locator("main section").filter({ has: page.locator("h1, h2") }).first();
  const pageText = await topCard.innerText().catch(() => "");

  if (/\b1st\b/.test(pageText)) throw new AlreadyConnectedError("Already connected");

  if (/\bPending\b/.test(pageText)) throw new PendingInviteError("Invitation already pending");
  const pendingBtn = topCard.locator('button[aria-label*="Pending"]:visible');
  if (await pendingBtn.count() > 0) throw new PendingInviteError("Invitation already pending");

  // Case 1: Direct Connect link visible in top card.
  // Scoped to topCard so sidebar "custom-invite" links are never matched.
  const directConnect = topCard.locator('a[aria-label*="Invite"][aria-label*="to connect"]:visible, a[href*="custom-invite"]:visible').first();
  if (await directConnect.count() > 0) {
    const href = await directConnect.getAttribute("href");
    if (!href) throw new Error("Connect link has no href");
    const inviteUrl = href.startsWith("http") ? href : `https://www.linkedin.com${href}`;
    await page.goto(inviteUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1000);
  } else {
    // Case 2: Connect is inside the "More" menu on the top card.
    // Scoped to topCard so nav-bar or sidebar More buttons are never matched.
    const moreBtn = topCard.locator('button[aria-label="More"]:visible').first();
    await moreBtn.click();
    await page.waitForTimeout(800);

    // Check for Pending in the menu
    const pendingMenuItem = page.locator('[role="menuitem"]:has-text("Pending"):visible');
    if (await pendingMenuItem.count() > 0) throw new PendingInviteError("Invitation already pending (found in More menu)");

    const connectOption = page.locator('[role="menuitem"]:has-text("Connect"):visible');
    if (await connectOption.count() === 0) throw new Error("Connect option not found in More menu");
    await connectOption.first().click();
  }

  await page.waitForTimeout(1000);

  // Click "Send without a note" / "Send now"
  const sendBtn = page.locator(
    'button:has-text("Send now"), button[aria-label*="Send without"], button[aria-label*="Send invitation"]:not([aria-label*="note"])'
  );
  if (await sendBtn.count() > 0) {
    await sendBtn.first().click({ force: true });
    await page.waitForTimeout(1500);
  }

  // Check for weekly limit popup
  const limitPopup = page.locator('div[class*="ip-fuse-limit-alert__warning"]');
  if (await limitPopup.count() > 0) throw new WeeklyLimitError("Weekly connection limit reached");

  // Check for error toast
  const errorToast = page.locator('div[data-test-artdeco-toast-item-type="error"]:visible');
  if (await errorToast.count() > 0) {
    const msg = await errorToast.innerText();
    throw new Error(`Connection error: ${msg.trim()}`);
  }
}
