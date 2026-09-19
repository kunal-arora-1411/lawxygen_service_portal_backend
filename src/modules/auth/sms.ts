import { ApiError } from "../../lib/api.js";
import { env } from "../../lib/env.js";
import { logger } from "../../lib/logger.js";

/**
 * Transactional SMS.
 *
 * India requires transactional SMS to be sent against a DLT-registered template through
 * a registered sender ID; an unregistered message is dropped by the carrier rather than
 * rejected at the API, so a "successful" send can silently deliver nothing.
 *
 * No provider is wired up yet. The important part of this file is what happens when the
 * credentials are missing: locally the code is logged so development works, and anywhere
 * else it throws. A deployed environment that quietly logs OTPs instead of sending them
 * would hand every account to whoever can read the logs, and would look healthy doing it.
 */

export type SmsSender = (phone: string, code: string) => Promise<void>;

/**
 * Local-only: prints the code so development works without an SMS provider.
 *
 * The key is `otpCodeForLocalDev`, not `code`, on purpose. The logger redacts `*.code`
 * precisely so a real OTP can never reach the logs — this deliberately steps around that
 * for the one case where there is no other way to obtain it, and names itself loudly so
 * it is obvious in a log and in a grep. `configuredSender` only ever returns this when
 * APP_ENV is local.
 */
const logOnly: SmsSender = (phone, code) => {
  logger.warn(
    { phone, otpCodeForLocalDev: code, channel: "sms-stub" },
    "OTP NOT SENT — no SMS provider configured; using the code below",
  );
  return Promise.resolve();
};

const refuse: SmsSender = () => {
  throw new ApiError("upstream_failure", "Unable to send a code right now. Please try again.");
};

function configuredSender(): SmsSender {
  if (!env.SMS_PROVIDER_KEY || !env.SMS_SENDER_ID || !env.SMS_DLT_TEMPLATE_ID) {
    if (env.APP_ENV === "local") return logOnly;
    logger.error("SMS provider is not configured; OTP delivery is refused");
    return refuse;
  }

  // Wire the provider here. It must fail loudly: a provider that accepts the request and
  // drops the message is indistinguishable from success unless the response is checked.
  return refuse;
}

let sender: SmsSender | undefined;

export async function sendOtpSms(phone: string, code: string): Promise<void> {
  sender ??= configuredSender();
  await sender(phone, code);
}

/** Test seam. Pass undefined to restore the configured sender. */
export function setSmsSender(override: SmsSender | undefined): void {
  sender = override;
}
