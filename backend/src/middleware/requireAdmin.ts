import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { admins } from "../db/schema.js";

// Gate for write routes mounted under /admin/*. Cloudflare Access sits in
// front of these paths and injects the authenticated user's email in the
// Cf-Access-Authenticated-User-Email header. We trust that header ONLY
// because Cloudflare terminates in front of the app and these paths are
// covered by an Access policy — reads are public and never reach here.
// As defense in depth, the email is also checked against the admins table.
export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const email = req.header("Cf-Access-Authenticated-User-Email")?.toLowerCase();
  if (!email) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  const [admin] = await db
    .select()
    .from(admins)
    .where(eq(admins.email, email));
  if (!admin) {
    return res.status(403).json({ error: "Not authorized" });
  }
  // Stash for any downstream per-admin logic.
  (req as Request & { adminEmail?: string }).adminEmail = email;
  next();
}
