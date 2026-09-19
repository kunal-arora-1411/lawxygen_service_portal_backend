import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { isUniqueViolation, PG, pgConstraintName, pgErrorCode } from "../../src/lib/db-errors.js";

/**
 * Integration tests against a real database.
 *
 * Skipped when DATABASE_URL is absent, so CI stays green without credentials. Run them
 * against a Neon branch — never a shared database — after `npm run db:migrate`.
 *
 * These assert the constraints the application relies on but never states in code: a
 * partial unique index is invisible at the type level, so the only way to know it is
 * there is to violate it on purpose.
 */

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

const sql = url ? postgres(url, { max: 1, prepare: !/-pooler\./.test(url) }) : undefined;
const created: string[] = [];

async function insertUser(values: Record<string, unknown>): Promise<string> {
  const rows = await sql!`insert into users ${sql!(values)} returning id`;
  const id = (rows[0] as { id: string }).id;
  created.push(id);
  return id;
}

afterAll(async () => {
  if (!sql) return;
  if (created.length) await sql`delete from users where id = any(${created})`;
  await sql.end({ timeout: 5 });
});

suite("users constraints", () => {
  it("rejects two emails differing only in case", async () => {
    const local = `case-${randomUUID()}`;
    await insertUser({ email: `${local}@example.com` });

    await expect(insertUser({ email: `${local.toUpperCase()}@EXAMPLE.com` })).rejects.toSatisfy(
      (error: unknown) => isUniqueViolation(error, "users_email_lower_uq"),
    );
  });

  it("allows many rows with no email, because the unique index is partial", async () => {
    await insertUser({ phone: `+9190000${Math.floor(Math.random() * 90000) + 10000}` });
    await insertUser({ phone: `+9190001${Math.floor(Math.random() * 90000) + 10000}` });
    // Reaching here without throwing is the assertion.
    expect(created.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects a duplicate phone", async () => {
    const phone = `+9199${Math.floor(Math.random() * 90000000) + 10000000}`;
    await insertUser({ phone });

    await expect(insertUser({ phone })).rejects.toSatisfy((error: unknown) =>
      isUniqueViolation(error, "users_phone_uq"),
    );
  });

  it("defaults a new account to an active client", async () => {
    const id = await insertUser({ email: `default-${randomUUID()}@example.com` });
    const rows = await sql!`select role, status from users where id = ${id}`;

    expect(rows[0]).toMatchObject({ role: "client", status: "active" });
  });

  it("rejects a role outside the enum", async () => {
    await expect(
      insertUser({ email: `bad-role-${randomUUID()}@example.com`, role: "root" }),
    ).rejects.toSatisfy((error: unknown) => pgErrorCode(error) === PG.INVALID_TEXT_REPRESENTATION);
  });
});

suite("referential behaviour", () => {
  it("deletes sessions with their user", async () => {
    const id = await insertUser({ email: `cascade-${randomUUID()}@example.com` });
    await sql!`insert into sessions (token_hash, user_id, expires_at)
               values (${randomUUID()}, ${id}, now() + interval '1 day')`;

    await sql!`delete from users where id = ${id}`;
    const rows = await sql!`select 1 from sessions where user_id = ${id}`;

    expect(rows).toHaveLength(0);
  });

  it("keeps an audit entry after its actor is deleted, with the actor nulled", async () => {
    const id = await insertUser({ email: `audit-${randomUUID()}@example.com` });
    const action = `test.${randomUUID()}`;
    await sql!`insert into audit_log (actor_user_id, action, resource_type)
               values (${id}, ${action}, 'test')`;

    await sql!`delete from users where id = ${id}`;
    const rows = await sql!`select actor_user_id from audit_log where action = ${action}`;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_user_id).toBeNull();

    await sql!`delete from audit_log where action = ${action}`;
  });
});

suite("error unwrapping", () => {
  /**
   * The bug this guards against is in the project's decision log: Drizzle wraps driver
   * errors, so `error.code` reads correctly, compiles, and is always undefined. Any
   * idempotency check written that way silently never matches.
   */
  it("exposes SQLSTATE only through pgErrorCode, not through error.code", async () => {
    const email = `unwrap-${randomUUID()}@example.com`;
    await insertUser({ email });

    try {
      await insertUser({ email });
      expect.unreachable("the duplicate insert should have thrown");
    } catch (error) {
      expect(pgErrorCode(error)).toBe(PG.UNIQUE_VIOLATION);
      expect(pgConstraintName(error)).toBe("users_email_lower_uq");
    }
  });
});
