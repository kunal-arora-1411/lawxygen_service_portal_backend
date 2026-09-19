/**
 * Runs before any test module is imported, mirroring the server's boot sequence.
 *
 * Integration tests that need a real database skip themselves when DATABASE_URL is
 * absent, so CI stays green without credentials.
 */
import "../src/lib/load-env.js";

/**
 * Tests get their own database, always.
 *
 * Sharing one with a running `npm run dev` corrupts both. The dev server's background
 * jobs are live — the outbox dispatcher every two seconds, the queue drain every
 * minute — so they consume the events a test just emitted and assign the test's orders
 * to whatever professionals happen to be seeded. That produced exactly the kind of
 * intermittent, unreproducible count mismatch that gets written off as flakiness, and
 * it cost real time before the cause was obvious.
 *
 * It runs the other way too: the suite deactivates every professional to isolate
 * itself, which silently breaks whatever you were demonstrating in the browser.
 *
 * Derived from DATABASE_URL by swapping the database name, so there is one thing to
 * configure rather than two that can disagree.
 */
const configured = process.env.DATABASE_URL;
if (configured && !process.env.TEST_DATABASE_URL) {
  const url = new URL(configured);
  url.pathname = `${url.pathname.replace(/\/$/, "")}_test`;
  process.env.TEST_DATABASE_URL = url.toString();
}
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

// Several tests assert on deliberate failures. Logging them buries the actual result.
process.env.LOG_LEVEL = "silent";

// Token hashing is keyed, so the unit tests need a key. A fixed value keeps digests
// reproducible across runs; it is never a real secret and must never become one.
process.env.SESSION_SECRET ??= "test-only-session-secret-not-for-any-real-environment";

// The Google tests stub the token exchange, but the authorize URL is still built for
// real and needs a client id. These are placeholders and reach no network.
process.env.GOOGLE_CLIENT_ID ??= "test-google-client-id.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ??= "test-google-client-secret";

// Field encryption for PAN and bank details. Test-only key.
process.env.FIELD_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

// Payments: the Orders API is stubbed, but webhook signatures are computed and verified
// for real against this secret, so the tests exercise the actual HMAC path.
process.env.RAZORPAY_KEY_ID ??= "rzp_test_placeholder";
process.env.RAZORPAY_KEY_SECRET ??= "test-razorpay-key-secret";
process.env.RAZORPAY_WEBHOOK_SECRET ??= "test-razorpay-webhook-secret";
