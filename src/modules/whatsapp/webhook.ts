import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import { logger } from "../../lib/logger.js";
import { webhookSecret } from "./client.js";
import { persistInbound, persistStatuses } from "./inbound.js";

/**
 * Meta's webhook.
 *
 * Mounted where the body is still a raw `Buffer`, because the signature covers the
 * exact bytes Meta sent. Verifying against a re-serialised object would fail on
 * nothing more than a different key order.
 *
 * Meta retries anything it does not see acknowledged quickly, so this answers 200 as
 * soon as the messages are **durably stored** — not after any downstream work. The
 * storage itself is idempotent, which is what makes a retry harmless.
 */

function verify(raw: Buffer, signature: string | undefined): boolean {
  const secret = webhookSecret();
  if (!secret || !signature?.startsWith("sha256=")) return false;

  const expected = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

type Payload = {
  object?: string;
  entry?: { changes?: { field?: string; value?: Record<string, unknown> }[] }[];
};

export function whatsappWebhookRoutes(): Router {
  const router = Router();

  /**
   * Meta's subscription handshake. It calls this once with a challenge and expects the
   * challenge echoed back in plain text.
   */
  router.get("/", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    // Express types a query value as string | string[] | ParsedQs; Meta sends one string.
    const challenge = req.query["hub.challenge"];
    const echo = typeof challenge === "string" ? challenge : "";

    if (mode === "subscribe" && token && token === webhookSecret()) {
      res.status(200).send(echo);
      return;
    }
    res.sendStatus(403);
  });

  router.post("/", (req: Request, res) => {
    void (async () => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
      const signature = req.header("x-hub-signature-256");

      if (!verify(raw, signature)) {
        // Anyone can reach this URL. Without a valid signature it is not from Meta.
        logger.warn("whatsapp webhook failed signature verification");
        res.sendStatus(403);
        return;
      }

      let payload: Payload;
      try {
        payload = JSON.parse(raw.toString("utf8")) as Payload;
      } catch {
        res.sendStatus(400);
        return;
      }

      if (payload.object !== "whatsapp_business_account") {
        res.sendStatus(404);
        return;
      }

      try {
        for (const entry of payload.entry ?? []) {
          for (const change of entry.changes ?? []) {
            if (change.field !== "messages" || !change.value) continue;
            await persistInbound(change.value);
            await persistStatuses(change.value);
          }
        }
        res.status(200).send("EVENT_RECEIVED");
      } catch (error) {
        /**
         * A 500 makes Meta retry, which is what we want when storage failed — the
         * alternative is acknowledging a message we did not keep.
         */
        logger.error({ err: error }, "whatsapp webhook failed");
        res.sendStatus(500);
      }
    })();
  });

  return router;
}
