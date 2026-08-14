import fs from "fs";
import path from "path";
import type { Page } from "playwright";

const DIR = path.join(process.cwd(), "public", "screenshots");
const MAX_AGE_MS = 48 * 60 * 60 * 1000;
const MAX_FILES = 200;

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

function purgeOld() {
  try {
    const files = fs.readdirSync(DIR)
      .map((f) => ({ f, t: fs.statSync(path.join(DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    const now = Date.now();
    files.forEach(({ f, t }, i) => {
      if (i >= MAX_FILES || now - t > MAX_AGE_MS) {
        try { fs.unlinkSync(path.join(DIR, f)); } catch { /* ignore */ }
      }
    });
  } catch { /* ignore */ }
}

export async function saveScreenshot(page: Page, label: string, targetId?: string): Promise<void> {
  try {
    ensureDir();
    purgeOld();
    const safe = label.replace(/[^a-z0-9_-]/gi, "_").slice(0, 60);
    const tid = targetId ? `${targetId}-` : "";
    const filename = `${Date.now()}-${tid}${safe}.png`;
    await page.screenshot({ path: path.join(DIR, filename), fullPage: false });
  } catch { /* never throw — screenshots are best-effort */ }
}

export function listScreenshots(targetId?: string): Array<{ filename: string; url: string; ts: number; label: string }> {
  try {
    ensureDir();
    return fs.readdirSync(DIR)
      .filter((f) => f.endsWith(".png"))
      .filter((f) => !targetId || f.includes(targetId))
      .map((f) => {
        const ts = parseInt(f.split("-")[0], 10);
        const label = f.replace(/^\d+-/, "").replace(/[a-f0-9-]{36}-/, "").replace(/\.png$/, "").replace(/_/g, " ");
        return { filename: f, url: `/screenshots/${f}`, ts, label };
      })
      .sort((a, b) => b.ts - a.ts)
      .slice(0, MAX_FILES);
  } catch {
    return [];
  }
}
