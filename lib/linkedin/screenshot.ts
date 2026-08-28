import fs from "fs";
import path from "path";
import type { Page } from "playwright";

// Save alongside the DB volume (/data/screenshots) so files survive container restarts
// and are writable by the node user. Falls back to public/screenshots for local dev.
const DATA_DIR = process.env.LINKI_DB_PATH
  ? path.dirname(process.env.LINKI_DB_PATH)
  : path.join(process.cwd(), "public");
const DIR = path.join(DATA_DIR, "screenshots");
function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

export async function saveScreenshot(page: Page, label: string, targetId?: string): Promise<void> {
  try {
    ensureDir();
    const safe = label.replace(/[^a-z0-9_-]/gi, "_").slice(0, 60);
    const tid = targetId ? `${targetId}-` : "";
    const filename = `${Date.now()}-${tid}${safe}.png`;
    await page.screenshot({ path: path.join(DIR, filename), fullPage: false });
  } catch { /* never throw — screenshots are best-effort */ }
}

export function clearScreenshots(targetId?: string): number {
  let deleted = 0;
  try {
    ensureDir();
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".png"));
    for (const f of files) {
      if (!targetId || f.includes(targetId)) {
        try { fs.unlinkSync(path.join(DIR, f)); deleted++; } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return deleted;
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
        return { filename: f, url: `/api/screenshots/${f}`, ts, label };
      })
      .sort((a, b) => b.ts - a.ts);
  } catch {
    return [];
  }
}
