import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }

  const db = getDb();

  // Find all distinct company names from targets
  const distinctNames = db.prepare(`
    SELECT DISTINCT TRIM(company) as name
    FROM targets
    WHERE company IS NOT NULL AND TRIM(company) != ''
    ORDER BY name COLLATE NOCASE
  `).all() as { name: string }[];

  let created = 0;
  let linked = 0;

  const insertCompany = db.prepare(`
    INSERT INTO companies (id, name) VALUES (?, ?)
  `);
  const findCompany = db.prepare(`
    SELECT id FROM companies WHERE LOWER(TRIM(name)) = LOWER(?) LIMIT 1
  `);
  const linkTargets = db.prepare(`
    UPDATE targets SET company_id = ?
    WHERE LOWER(TRIM(company)) = LOWER(?) AND company_id IS NULL
  `);

  const run = db.transaction(() => {
    for (const { name } of distinctNames) {
      let existing = findCompany.get(name) as { id: string } | undefined;
      if (!existing) {
        const newId = randomUUID();
        insertCompany.run(newId, name);
        created++;
        existing = { id: newId };
      }
      const result = linkTargets.run(existing.id, name);
      linked += result.changes;
    }
  });
  run();

  return res.json({ created, linked });
}
