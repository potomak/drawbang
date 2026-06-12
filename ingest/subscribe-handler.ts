import { EMAIL_RE } from "../config/constants.js";
import {
  type BaseHandlerConfig,
  type Result,
  err,
  ok,
} from "./handler-utils.js";
import type { SubscribersStore } from "./subscribers-store.js";

// POST /subscribe — public email capture from the home-page hero. No
// session required. The hidden `website` field is a honeypot: bots that
// fill it get a silent 200 and no write, so they can't tell they were
// filtered.

export interface SubscribeHandlerConfig extends BaseHandlerConfig {
  subscribersStore: SubscribersStore;
}

export async function handleSubscribe(
  rawBody: string,
  cfg: SubscribeHandlerConfig,
): Promise<Result> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return err(400, "bad json");
  }
  if (typeof parsed !== "object" || parsed === null) return err(400, "bad json");
  const body = parsed as { email?: unknown; website?: unknown };
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return ok();
  }
  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email.length === 0 || email.length > 254 || !EMAIL_RE.test(email)) {
    return err(400, "invalid email");
  }
  const now = cfg.now ? cfg.now() : new Date();
  await cfg.subscribersStore.subscribe(email, now.toISOString());
  return ok();
}
