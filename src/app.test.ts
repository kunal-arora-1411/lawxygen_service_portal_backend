import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { ApiError } from "./lib/api.js";
import { handler } from "./lib/http.js";

/**
 * The response envelope is the contract the portal generates its client against, so it is
 * worth proving it survives Express rather than assuming it does. A handler that throws
 * must still produce `{ ok: false, code }` and the status the code maps to — if that ever
 * silently becomes an HTML error page, every client call site breaks at once.
 */

const app = createApp();

describe("health", () => {
  it("reports liveness without touching the database", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.status).toBe("ok");
  });
});

describe("error envelope", () => {
  it("returns a typed failure for an unknown route", async () => {
    const res = await request(app).get("/no-such-thing");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ ok: false, code: "not_found" });
  });

  it("maps each ApiError code to its status and preserves the message", async () => {
    const cases = [
      { code: "unauthenticated", status: 401 },
      { code: "forbidden", status: 403 },
      { code: "not_found", status: 404 },
      { code: "invalid_input", status: 400 },
      { code: "conflict", status: 409 },
      { code: "rate_limited", status: 429 },
      { code: "upstream_failure", status: 502 },
    ] as const;

    for (const { code, status } of cases) {
      const probe = createApp((a) =>
        a.get(
          "/boom",
          handler(() => {
            throw new ApiError(code, `failed with ${code}`);
          }),
        ),
      );

      const res = await request(probe).get("/boom");
      expect(res.status, `${code} should be ${status}`).toBe(status);
      expect(res.body).toMatchObject({ ok: false, code, message: `failed with ${code}` });
    }
  });

  it("never leaks the message of an unexpected error", async () => {
    const probe = createApp((a) =>
      a.get(
        "/boom",
        handler(() => {
          throw new Error("connection string is postgres://user:hunter2@host/db");
        }),
      ),
    );

    const res = await request(probe).get("/boom");

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ ok: false, code: "internal" });
    expect(JSON.stringify(res.body)).not.toContain("hunter2");
  });

  it("catches a rejected promise from an async handler", async () => {
    const probe = createApp((a) =>
      a.get(
        "/boom",
        handler(async () => {
          await Promise.resolve();
          throw new ApiError("conflict", "taken a millisecond ago");
        }),
      ),
    );

    const res = await request(probe).get("/boom");

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, code: "conflict" });
  });
});
