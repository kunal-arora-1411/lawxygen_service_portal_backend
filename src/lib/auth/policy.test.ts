import { describe, expect, it } from "vitest";
import { authorize, Forbidden, hasAtLeast, ownsOrAdmin, type Actor } from "./policy.js";

const client: Actor = { userId: "u-client", role: "client" };
const professional: Actor = { userId: "u-pro", role: "professional", professionalId: "p-1" };
const admin: Actor = { userId: "u-admin", role: "admin" };
const superadmin: Actor = { userId: "u-super", role: "superadmin" };
const impersonatingAdmin: Actor = {
  userId: "u-client",
  role: "admin",
  impersonatorId: "u-super",
};

describe("hasAtLeast", () => {
  it("ranks roles in ascending privilege", () => {
    expect(hasAtLeast("client", "client")).toBe(true);
    expect(hasAtLeast("client", "professional")).toBe(false);
    expect(hasAtLeast("professional", "client")).toBe(true);
    expect(hasAtLeast("admin", "professional")).toBe(true);
    expect(hasAtLeast("superadmin", "admin")).toBe(true);
    expect(hasAtLeast("admin", "superadmin")).toBe(false);
  });
});

describe("ownsOrAdmin", () => {
  it("lets an owner act on their own resource", () => {
    expect(ownsOrAdmin(client, "u-client")).toBe(true);
  });

  it("refuses a different client", () => {
    expect(ownsOrAdmin(client, "someone-else")).toBe(false);
  });

  it("refuses a professional acting on an unrelated client's resource", () => {
    expect(ownsOrAdmin(professional, "u-client")).toBe(false);
  });

  it("allows admin and superadmin", () => {
    expect(ownsOrAdmin(admin, "u-client")).toBe(true);
    expect(ownsOrAdmin(superadmin, "u-client")).toBe(true);
  });
});

describe("authorize", () => {
  it("permits an action within the actor's role", () => {
    expect(() => authorize(admin, "professional.verify", { minimumRole: "admin" })).not.toThrow();
  });

  it("refuses an action above the actor's role", () => {
    expect(() => authorize(client, "professional.verify", { minimumRole: "admin" })).toThrow(
      Forbidden,
    );
    expect(() => authorize(professional, "payout.release", { minimumRole: "admin" })).toThrow(
      Forbidden,
    );
  });

  it("refuses an action on a resource the actor does not own", () => {
    expect(() => authorize(client, "order.cancel", { ownerUserId: "someone-else" })).toThrow(
      Forbidden,
    );
  });

  it("permits an admin to act on another user's resource", () => {
    expect(() => authorize(admin, "order.cancel", { ownerUserId: "u-client" })).not.toThrow();
  });

  describe("while impersonating", () => {
    it("refuses money movement regardless of role", () => {
      for (const action of ["payout.release", "payout.hold", "refund.approve", "invoice.reissue"]) {
        expect(
          () => authorize(impersonatingAdmin, action, { minimumRole: "admin" }),
          `${action} must be refused while impersonating`,
        ).toThrow(Forbidden);
      }
    });

    it("refuses privilege escalation and deletion", () => {
      expect(() => authorize(impersonatingAdmin, "user.role.change")).toThrow(Forbidden);
      expect(() => authorize(impersonatingAdmin, "user.delete")).toThrow(Forbidden);
    });

    it("still permits ordinary support actions", () => {
      expect(() => authorize(impersonatingAdmin, "order.reschedule")).not.toThrow();
    });

    it("refuses even a superadmin — the restriction is on the mode, not the rank", () => {
      const impersonatingSuper: Actor = {
        userId: "u-client",
        role: "superadmin",
        impersonatorId: "u-super",
      };
      expect(() => authorize(impersonatingSuper, "payout.release")).toThrow(Forbidden);
    });
  });

  it("carries the forbidden code for the API boundary", () => {
    try {
      authorize(client, "payout.release", { minimumRole: "admin" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(Forbidden);
      expect((error as Forbidden).code).toBe("forbidden");
    }
  });
});
