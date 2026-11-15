import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { siteBanner } from "../db/schema.js";
import { isIsoDate, isSafeLink, optionalText } from "../lib/validate.js";

// The site-wide announcement banner: one message or none. Reads are public;
// writes are admin-only under /admin/banner. See siteBanner in schema.ts.

const MESSAGE_MAX = 280;
const LABEL_MAX = 40;
const BANNER_ID = 1;

// Everything except updatedBy, which is an email address.
const publicColumns = {
  message: siteBanner.message,
  linkUrl: siteBanner.linkUrl,
  linkLabel: siteBanner.linkLabel,
  startsOn: siteBanner.startsOn,
  endsOn: siteBanner.endsOn,
  updatedAt: siteBanner.updatedAt,
};

// Public read route, mounted at /banner. Returns the banner whatever its
// dates — the browser decides whether today falls inside them (see schema.ts
// for why), and the admin editor needs to see a scheduled or expired one.
// `null` when there is no banner, rather than a 404: "nothing to announce" is
// the normal state, not an error for every page load to log.
export const bannerRouter = Router();

bannerRouter.get("/", async (_req, res, next) => {
  try {
    const [row] = await db
      .select(publicColumns)
      .from(siteBanner)
      .where(eq(siteBanner.id, BANNER_ID));
    res.json(row ?? null);
  } catch (err) {
    next(err);
  }
});

// Admin write routes, mounted at /admin/banner (behind requireAdmin).
export const bannerAdminRouter = Router();

// Set the banner, replacing whatever was there. PUT, not PATCH: the editor
// always sends the whole thing, and an omitted field means "none".
bannerAdminRouter.put("/", async (req, res, next) => {
  try {
    const b = req.body ?? {};

    const message = typeof b.message === "string" ? b.message.trim() : "";
    if (!message) return res.status(400).json({ error: "message is required" });
    if (message.length > MESSAGE_MAX) {
      return res
        .status(400)
        .json({ error: `message must be ${MESSAGE_MAX} characters or fewer` });
    }

    const rawLink = typeof b.linkUrl === "string" ? b.linkUrl.trim() : "";
    const linkUrl = rawLink || null;
    if (linkUrl && !isSafeLink(linkUrl)) {
      return res.status(400).json({
        error: "link must be a web address (https://…) or an app path like #/calendar",
      });
    }
    const label = optionalText(b.linkLabel, LABEL_MAX, "linkLabel");
    if ("error" in label) return res.status(400).json({ error: label.error });
    // A label with nowhere to go would render as dead text that looks tappable.
    const linkLabel = linkUrl ? label.value ?? null : null;

    const startsOn = b.startsOn || null;
    const endsOn = b.endsOn || null;
    if (startsOn !== null && !isIsoDate(startsOn)) {
      return res.status(400).json({ error: "startsOn must be a date (YYYY-MM-DD)" });
    }
    if (endsOn !== null && !isIsoDate(endsOn)) {
      return res.status(400).json({ error: "endsOn must be a date (YYYY-MM-DD)" });
    }
    if (startsOn && endsOn && endsOn < startsOn) {
      return res.status(400).json({ error: "endsOn can't be before startsOn" });
    }

    const values = {
      message,
      linkUrl,
      linkLabel,
      startsOn,
      endsOn,
      updatedAt: new Date(),
      updatedBy: (req as Request & { adminEmail?: string }).adminEmail ?? null,
    };
    const [row] = await db
      .insert(siteBanner)
      .values({ id: BANNER_ID, ...values })
      .onConflictDoUpdate({ target: siteBanner.id, set: values })
      .returning(publicColumns);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// Remove the banner. Idempotent: removing nothing is still "no banner".
bannerAdminRouter.delete("/", async (_req, res, next) => {
  try {
    await db.delete(siteBanner).where(eq(siteBanner.id, BANNER_ID));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
