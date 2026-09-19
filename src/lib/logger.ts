import pino from "pino";
import { env } from "./env.js";

/**
 * Structured logging.
 *
 * The redaction list is not decoration. This system handles passwords, OTP codes, session
 * cookies, PAN and bank details; a cross-cutting standard for the project is that no
 * personal data reaches the logs, and the cheapest way to hold that line is to make the
 * logger incapable of printing the fields in the first place.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
      "*.password",
      "*.passwordHash",
      "*.token",
      "*.tokenHash",
      "*.code",
      "*.codeHash",
      "*.otp",
      "*.pan",
      "*.gstin",
      "*.accountNumber",
      "*.ifsc",
    ],
    censor: "[redacted]",
  },
  ...(env.APP_ENV === "local"
    ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: true } } }
    : {}),
});
