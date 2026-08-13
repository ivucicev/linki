import type { Page } from "playwright";
import type { InMailSurface } from "@/lib/premium";

/**
 * Sends a Sales Navigator InMail from the lead's Sales Nav profile page.
 *
 * Flow: navigate → click Message button → fill subject + body → send.
 * Sales Nav InMails reach non-connections; the subject line is required.
 *
 * Selectors are tried in order of specificity so minor LinkedIn UI changes
 * don't break the whole flow. Throws on hard failures so the runner can
 * log and reschedule.
 */
export async function sendInMail(
  page: Page,
  salesNavUrl: string,
  subject: string,
  body: string,
): Promise<void> {
  // Navigate to the Sales Nav profile page
  await page.goto(salesNavUrl, { waitUntil: "domcontentloaded", timeout: 40000 });
  await page.waitForTimeout(3000 + Math.random() * 1500);

  // Verify we're still logged in
  const url = page.url();
  if (/\/login|\/authwall|\/checkpoint|\/uas\//.test(url)) {
    throw new Error(`Sales Nav session expired before InMail — landed on: ${url}`);
  }

  // ── Step 1: Click the Message / InMail button ────────────────────────────

  // Multiple selector candidates — Sales Nav has changed button labels over time
  const messageButtonSelectors = [
    // Sales Nav profile "Message" primary action
    'button[data-control-name="send_message"]',
    'button[data-view-name="profile-topcard-send-inmail"]',
    // Text-based selectors as fallback
    'button:has-text("Message")',
    'button:has-text("InMail")',
    'button:has-text("Send InMail")',
    // Generic action bar button
    '[data-anonymize="false"] button:has-text("Message")',
  ];

  let clicked = false;
  for (const sel of messageButtonSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 3000 })) {
        await btn.click({ delay: 100 });
        clicked = true;
        break;
      }
    } catch { /* try next */ }
  }

  if (!clicked) {
    // Last resort: look for any visible button containing "message" or "inmail"
    const allButtons = page.locator("button");
    const count = await allButtons.count();
    for (let i = 0; i < count; i++) {
      const btn = allButtons.nth(i);
      const text = (await btn.innerText().catch(() => "")).toLowerCase();
      if ((text.includes("message") || text.includes("inmail")) && await btn.isVisible()) {
        await btn.click({ delay: 100 });
        clicked = true;
        break;
      }
    }
  }

  if (!clicked) {
    throw new Error("Could not find Message/InMail button on Sales Nav profile page");
  }

  await page.waitForTimeout(1500 + Math.random() * 800);

  // ── Step 2: Fill in the subject line ────────────────────────────────────

  const subjectSelectors = [
    "input#inmail-subject",
    'input[name="subject"]',
    'input[placeholder*="subject" i]',
    'input[placeholder*="Subject" i]',
    ".artdeco-text-input--input[data-test-compose-subject]",
    // Modal/compose pane
    '[data-test-inmail-subject-input]',
    'form input[type="text"]',
  ];

  let subjectFilled = false;
  for (const sel of subjectSelectors) {
    try {
      const input = page.locator(sel).first();
      if (await input.isVisible({ timeout: 3000 })) {
        await input.click();
        await input.fill(subject);
        subjectFilled = true;
        break;
      }
    } catch { /* try next */ }
  }

  if (!subjectFilled) {
    throw new Error("Could not find subject input in InMail compose dialog");
  }

  await page.waitForTimeout(500);

  // ── Step 3: Fill in the message body ────────────────────────────────────

  const bodySelectors = [
    ".artdeco-text-input--input[data-test-compose-body]",
    "div.msg-form__contenteditable",
    "div[contenteditable='true']",
    'textarea[name="body"]',
    'textarea[placeholder*="message" i]',
    'textarea[placeholder*="Message" i]',
    '[data-test-inmail-body-input]',
    ".compose-text-area",
    ".inmail-compose-form__message",
  ];

  let bodyFilled = false;
  for (const sel of bodySelectors) {
    try {
      const area = page.locator(sel).first();
      if (await area.isVisible({ timeout: 3000 })) {
        await area.click();
        // Use clipboard paste to handle special characters reliably
        try {
          await page.evaluate((t) => navigator.clipboard.writeText(t), body);
          await page.waitForTimeout(200);
          await area.press("Control+V");
        } catch {
          await area.pressSequentially(body, { delay: 15 });
        }
        bodyFilled = true;
        break;
      }
    } catch { /* try next */ }
  }

  if (!bodyFilled) {
    throw new Error("Could not find body input in InMail compose dialog");
  }

  await page.waitForTimeout(800);

  // ── Step 4: Send ──────────────────────────────────────────────────────────

  const sendSelectors = [
    'button[data-test-send-inmail-btn]',
    'button[data-control-name="send"]',
    'button:has-text("Send")',
    'button[type="submit"]:has-text("Send")',
    ".msg-form__send-button",
    ".artdeco-button--primary:has-text('Send')",
  ];

  let sent = false;
  for (const sel of sendSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 3000 })) {
        await btn.click({ delay: 100 });
        sent = true;
        break;
      }
    } catch { /* try next */ }
  }

  if (!sent) {
    throw new Error("Could not find Send button in InMail compose dialog");
  }

  // Wait for the compose dialog to close or a success indicator
  await page.waitForTimeout(2500);

  // Check for error toasts / confirmation
  const errorToast = page.locator('[data-test-artdeco-toast-item-type="error"]');
  if (await errorToast.isVisible({ timeout: 2000 }).catch(() => false)) {
    const msg = await errorToast.innerText().catch(() => "unknown error");
    throw new Error(`Sales Nav InMail send failed: ${msg}`);
  }
}

export const inmail: InMailSurface = { sendInMail };
