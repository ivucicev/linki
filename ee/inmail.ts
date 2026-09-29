import type { Page } from "playwright";
import type { InMailSurface } from "@/lib/premium";
import { saveScreenshot } from "@/lib/linkedin/screenshot";

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
  targetId?: string,
): Promise<void> {
  // Navigate to the Sales Nav profile page
  await page.goto(salesNavUrl, { waitUntil: "domcontentloaded", timeout: 40000 });
  await page.waitForTimeout(3000 + Math.random() * 1500);

  // Verify we're still logged in
  const url = page.url();
  if (/\/login|\/authwall|\/checkpoint|\/uas\//.test(url)) {
    await saveScreenshot(page, "inmail_session_expired", targetId);
    throw new Error(`Sales Nav session expired before InMail — landed on: ${url}`);
  }
  await saveScreenshot(page, "inmail_profile_loaded", targetId);

  // ── Step 1: Click the Message / InMail button ────────────────────────────

  // Multiple selector candidates — Sales Nav has changed button labels over time
  const messageButtonSelectors = [
    // Current Sales Nav UI (confirmed from DOM inspection)
    'button[data-anchor-send-inmail]',
    // Previous Sales Nav selectors
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
      if (await btn.isVisible({ timeout: 500 })) {
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
    await saveScreenshot(page, "inmail_no_message_btn", targetId);
    throw new Error("Could not find Message/InMail button on Sales Nav profile page");
  }

  await page.waitForTimeout(1500 + Math.random() * 800);
  await saveScreenshot(page, "inmail_compose_opened", targetId);

  // ── Step 2: Fill in the subject line ────────────────────────────────────

  const subjectSelectors = [
    // Current Sales Nav UI (confirmed from DOM inspection)
    'input[aria-label="Subject (required)"]',
    'input._subject-field_jrrmou',
    // Previous selectors
    "input#inmail-subject",
    'input[name="subject"]',
    'input[placeholder*="subject" i]',
    'input[placeholder*="Subject" i]',
    ".artdeco-text-input--input[data-test-compose-subject]",
    '[data-test-inmail-subject-input]',
    'form input[type="text"]',
  ];

  let subjectFilled = false;
  for (const sel of subjectSelectors) {
    try {
      const input = page.locator(sel).first();
      if (await input.isVisible({ timeout: 200 })) {
        await input.click();
        await input.fill(subject);
        subjectFilled = true;
        break;
      }
    } catch { /* try next */ }
  }

  if (!subjectFilled) {
    // Already connected — Sales Nav opens a regular message dialog without a subject field.
    // This is expected; give dialog extra time to render, then proceed to fill body directly.
    await saveScreenshot(page, "inmail_no_subject_connected", targetId);
    await page.waitForTimeout(1500);
  }

  await page.waitForTimeout(500);

  // ── Step 3: Fill in the message body ────────────────────────────────────

  const bodySelectors = [
    // Current Sales Nav UI (confirmed from DOM inspection — both connected and non-connected)
    'textarea[aria-label="Type your message here or create draft"]',
    'textarea[name="message"]',
    'textarea._message-field_jrrmou',
    'textarea[aria-label*="message" i]',
    // Previous selectors
    ".artdeco-text-input--input[data-test-compose-body]",
    '[data-test-inmail-body-input]',
    "div.msg-form__contenteditable",
    'div[role="textbox"]:not([data-test-inmail-subject-input])',
    'div[contenteditable="true"][aria-label*="message" i]',
    'div[contenteditable="true"][aria-label*="body" i]',
    ".ip-compose-form__body div[contenteditable]",
    ".inmail-compose-form__message",
    ".compose-text-area",
    'textarea[name="body"]',
  ];

  let bodyFilled = false;

  // First try: selector-based
  for (const sel of bodySelectors) {
    try {
      const area = page.locator(sel).first();
      if (await area.isVisible({ timeout: 5000 })) {
        await area.click();
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

  // Fallback: Tab from subject field into body
  if (!bodyFilled) {
    try {
      await page.keyboard.press("Tab");
      await page.waitForTimeout(400);
      const focused = page.locator(":focus");
      const tag = await focused.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
      const ce = await focused.getAttribute("contenteditable").catch(() => null);
      if (tag === "textarea" || tag === "input" || ce === "true") {
        await focused.press("Control+a");
        try {
          await page.evaluate((t) => navigator.clipboard.writeText(t), body);
          await page.waitForTimeout(200);
          await focused.press("Control+V");
        } catch {
          await focused.pressSequentially(body, { delay: 15 });
        }
        bodyFilled = true;
      }
    } catch { /* ignore */ }
  }

  if (!bodyFilled) {
    await saveScreenshot(page, "inmail_no_body_field", targetId);
    throw new Error("Could not find body input in InMail compose dialog");
  }

  await saveScreenshot(page, "inmail_body_typed", targetId);
  await page.waitForTimeout(800);

  // ── Step 4: Send ──────────────────────────────────────────────────────────

  const sendSelectors = [
    // Current Sales Nav UI (confirmed from DOM inspection)
    'button._button_fx0fxz',
    // Previous selectors
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
      if (await btn.isVisible({ timeout: 500 })) {
        await btn.click({ delay: 100 });
        sent = true;
        break;
      }
    } catch { /* try next */ }
  }

  if (!sent) {
    await saveScreenshot(page, "inmail_no_send_btn", targetId);
    throw new Error("Could not find Send button in InMail compose dialog");
  }

  // Wait for the compose dialog to close or a success indicator
  await page.waitForTimeout(2500);
  await saveScreenshot(page, "inmail_after_send", targetId);

  // Check for error toasts / confirmation
  const errorToast = page.locator('[data-test-artdeco-toast-item-type="error"]');
  if (await errorToast.isVisible({ timeout: 2000 }).catch(() => false)) {
    const msg = await errorToast.innerText().catch(() => "unknown error");
    await saveScreenshot(page, "inmail_send_error_toast", targetId);
    throw new Error(`Sales Nav InMail send failed: ${msg}`);
  }
}

export const inmail: InMailSurface = { sendInMail };
