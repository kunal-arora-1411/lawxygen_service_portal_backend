import { and, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import { db } from "../../db/client.js";
import {
  categories,
  payoutBatches,
  payoutIdentities,
  payouts,
  professionalCategories,
  professionalCredentials,
  professionals,
  users,
  type ProfessionalKind,
  type ProfessionalStatus,
} from "../../db/schema/index.js";
import { ApiError } from "../../lib/api.js";
import { recordAudit } from "../../lib/auth/audit.js";
import { authorize, type Actor } from "../../lib/auth/policy.js";
import { decryptField, encryptField } from "../../lib/field-encryption.js";
import type {
  applySchema,
  credentialSchema,
  payoutIdentitySchema,
  updateProfileSchema,
} from "./schemas.js";

/**
 * Becoming a professional.
 *
 * Until this existed, every professional in the system arrived by hand-run SQL. The
 * payout machinery could not pay anybody, because a real person had no way to enter a
 * bank account, and the admin verification queue reviewed applicants who could not
 * apply.
 *
 * The shape is a draft that the applicant fills in at their own pace and then submits.
 * `status` is admin's word and `available` is the professional's, which is why they
 * are separate columns: verifying somebody does not switch them on, and somebody going
 * on holiday does not un-verify them.
 *
 * **No document upload.** The registration number is checked against ICAI's, ICSI's or
 * the relevant Bar Council's public register, which is a stronger check than a PDF
 * somebody uploaded. Storage, signed URLs, virus scanning and a retention policy are a
 * real piece of work and a product decision that has not been made; asking for a file
 * and putting it somewhere careless would be worse than asking for the number.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ReadinessCheck = {
  /** Machine-readable so the UI can link to the right step. */
  key: "categories" | "credential" | "payout";
  done: boolean;
  label: string;
};

export type ApplicationView = {
  id: string;
  kind: ProfessionalKind;
  displayName: string;
  headline: string | null;
  city: string | null;
  status: ProfessionalStatus;
  available: boolean;
  concurrentCapacity: number;
  categories: { slug: string; label: string }[];
  credentials: {
    id: string;
    body: string;
    registrationNumber: string;
    status: string;
    reviewNote: string | null;
  }[];
  payout: {
    /** Never the number itself. */
    panMasked: string;
    gstinSet: boolean;
    accountLast4: string;
    ifsc: string;
    accountHolderName: string;
  } | null;
  readiness: ReadinessCheck[];
  /** True when every check passes and the status allows submitting. */
  submittable: boolean;
  verifiedAt: string | null;
  createdAt: string;
};

/** Statuses an applicant may still edit. Verified details change through support. */
const EDITABLE: ProfessionalStatus[] = ["draft", "rejected"];

/**
 * A PAN is personal data and nothing here needs to read it back — but an applicant
 * checking they entered the right one does. First two and last two characters place
 * it without disclosing it.
 */
function maskPan(encrypted: string): string {
  try {
    const pan = decryptField(encrypted);
    return `${pan.slice(0, 2)}••••••${pan.slice(-2)}`;
  } catch {
    // A key rotation that has not reached this row must not break the whole screen.
    return "••••••••••";
  }
}

async function requireOwn(actor: Actor): Promise<{ id: string; status: ProfessionalStatus }> {
  const [row] = await db
    .select({ id: professionals.id, status: professionals.status })
    .from(professionals)
    .where(eq(professionals.userId, actor.userId))
    .limit(1);

  if (!row) throw new ApiError("not_found", "You have not applied yet.");
  return row;
}

function assertEditable(status: ProfessionalStatus): void {
  if (EDITABLE.includes(status)) return;
  if (status === "pending_review") {
    throw new ApiError("conflict", "Your application is being reviewed. Withdraw it to edit.");
  }
  throw new ApiError("conflict", "Verified details are changed through support.");
}

/** Resolves category slugs to ids, refusing unknown ones rather than silently dropping. */
async function categoryIds(tx: Tx, slugs: string[]): Promise<string[]> {
  const rows = await tx
    .select({ id: categories.id, slug: categories.slug })
    .from(categories)
    .where(inArray(categories.slug, slugs));

  const found = new Set(rows.map((r) => r.slug));
  const missing = slugs.filter((s) => !found.has(s));
  if (missing.length > 0) {
    throw new ApiError("invalid_input", `No such category: ${missing.join(", ")}.`, {
      fieldErrors: { categories: missing.map((slug) => `No such category: ${slug}`) },
    });
  }
  return rows.map((r) => r.id);
}

async function replaceCategories(tx: Tx, professionalId: string, slugs: string[]): Promise<void> {
  const ids = await categoryIds(tx, slugs);
  await tx
    .delete(professionalCategories)
    .where(eq(professionalCategories.professionalId, professionalId));
  await tx
    .insert(professionalCategories)
    .values(ids.map((categoryId) => ({ professionalId, categoryId })));
}

/**
 * Applying.
 *
 * The user's role is promoted to `professional` here rather than on approval, because
 * the whole onboarding flow lives behind `requireRole("professional")` and an applicant
 * has to reach it. Nothing is granted by the role itself: assignment requires
 * `status = 'verified'`, and roles are ranked, so a client loses no access by gaining
 * it. `resolveSession` reads the role fresh on every request, so it takes effect
 * immediately.
 */
export async function applyAsProfessional(
  actor: Actor,
  input: z.infer<typeof applySchema>,
): Promise<ApplicationView> {
  const [existing] = await db
    .select({ id: professionals.id })
    .from(professionals)
    .where(eq(professionals.userId, actor.userId))
    .limit(1);

  if (existing) throw new ApiError("conflict", "You have already applied.");

  const id = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(professionals)
      .values({
        userId: actor.userId,
        kind: input.kind,
        displayName: input.displayName,
        ...(input.headline ? { headline: input.headline } : {}),
        ...(input.city ? { city: input.city } : {}),
        status: "draft",
        // Off until verified and until they say otherwise. Being listed as available
        // while unverified would put them in the eligibility query's way for nothing.
        available: false,
      })
      .returning({ id: professionals.id });

    if (!created) throw new ApiError("internal", "Could not create the application.");

    await replaceCategories(tx, created.id, input.categories);

    // Only a promotion. An admin who applies stays an admin.
    await tx
      .update(users)
      .set({ role: "professional" })
      .where(and(eq(users.id, actor.userId), eq(users.role, "client")));

    await recordAudit(
      {
        actor,
        action: "professional.applied",
        resourceType: "professional",
        resourceId: created.id,
        after: { kind: input.kind, displayName: input.displayName },
      },
      tx,
    );

    return created.id;
  });

  return applicationById(id);
}

export async function updateApplication(
  actor: Actor,
  input: z.infer<typeof updateProfileSchema>,
): Promise<ApplicationView> {
  const own = await requireOwn(actor);

  /**
   * Capacity is the one field a verified professional may change on their own, because
   * it is about how much work they can take rather than who they are. Everything else
   * is what admin verified.
   */
  const onlyCapacity =
    input.concurrentCapacity !== undefined &&
    input.displayName === undefined &&
    input.headline === undefined &&
    input.city === undefined &&
    input.categories === undefined;

  if (!onlyCapacity) assertEditable(own.status);

  await db.transaction(async (tx) => {
    const patch: Record<string, unknown> = {};
    if (input.displayName !== undefined) patch.displayName = input.displayName;
    if (input.headline !== undefined) patch.headline = input.headline;
    if (input.city !== undefined) patch.city = input.city;
    if (input.concurrentCapacity !== undefined) {
      patch.concurrentCapacity = input.concurrentCapacity;
    }

    if (Object.keys(patch).length > 0) {
      await tx.update(professionals).set(patch).where(eq(professionals.id, own.id));
    }
    if (input.categories) await replaceCategories(tx, own.id, input.categories);
  });

  return applicationById(own.id);
}

export async function addCredential(
  actor: Actor,
  input: z.infer<typeof credentialSchema>,
): Promise<ApplicationView> {
  const own = await requireOwn(actor);
  assertEditable(own.status);

  await db.insert(professionalCredentials).values({
    professionalId: own.id,
    body: input.body,
    registrationNumber: input.registrationNumber,
  });

  return applicationById(own.id);
}

export async function removeCredential(actor: Actor, credentialId: string): Promise<void> {
  const own = await requireOwn(actor);
  assertEditable(own.status);

  // Scoped to their own row: an id from somewhere else matches nothing.
  await db
    .delete(professionalCredentials)
    .where(
      and(
        eq(professionalCredentials.id, credentialId),
        eq(professionalCredentials.professionalId, own.id),
      ),
    );
}

/**
 * Bank and tax details.
 *
 * Encrypted at field level on the way in, and never decrypted into a response — the
 * only things that come back out are the last four digits of the account, which are
 * stored in the clear for exactly this, and a masked PAN.
 *
 * Refused while a drafted payout batch includes them. `sendPayout` resolves the bank
 * details at release time rather than from the batch, so changing an account between
 * drafting and releasing would redirect money that operations has already approved.
 */
export async function savePayoutIdentity(
  actor: Actor,
  input: z.infer<typeof payoutIdentitySchema>,
): Promise<ApplicationView> {
  const own = await requireOwn(actor);

  const [held] = await db
    .select({ reference: payoutBatches.reference })
    .from(payouts)
    .innerJoin(payoutBatches, eq(payoutBatches.id, payouts.batchId))
    .where(
      and(
        eq(payouts.professionalId, own.id),
        eq(payouts.status, "pending"),
        inArray(payoutBatches.status, ["draft", "releasing"]),
      ),
    )
    .limit(1);

  if (held) {
    throw new ApiError(
      "conflict",
      `Payout batch ${held.reference} is waiting to be released to this account. Bank details cannot change until it has been.`,
    );
  }

  const values = {
    professionalId: own.id,
    panEncrypted: encryptField(input.pan),
    ...(input.gstin ? { gstinEncrypted: encryptField(input.gstin) } : { gstinEncrypted: null }),
    accountNumberEncrypted: encryptField(input.accountNumber),
    ifsc: input.ifsc,
    accountHolderName: input.accountHolderName,
    accountLast4: input.accountNumber.slice(-4),
  };

  await db.transaction(async (tx) => {
    await tx
      .insert(payoutIdentities)
      .values(values)
      .onConflictDoUpdate({ target: payoutIdentities.professionalId, set: values });

    /**
     * Audited without any of the values. That somebody changed their bank account is
     * exactly the event a fraud review wants to see; the number itself would put in
     * the audit log the thing field encryption exists to keep out of it.
     */
    await recordAudit(
      {
        actor,
        action: "professional.payout_identity.changed",
        resourceType: "professional",
        resourceId: own.id,
        after: { accountLast4: values.accountLast4, ifsc: values.ifsc },
      },
      tx,
    );
  });

  return applicationById(own.id);
}

/** Submitting for review. Refuses while anything is missing, and says what. */
export async function submitForReview(actor: Actor): Promise<ApplicationView> {
  const own = await requireOwn(actor);
  assertEditable(own.status);

  const view = await applicationById(own.id);
  const outstanding = view.readiness.filter((check) => !check.done);
  if (outstanding.length > 0) {
    throw new ApiError("conflict", `Still needed: ${outstanding.map((c) => c.label).join("; ")}.`);
  }

  await db.transaction(async (tx) => {
    await tx
      .update(professionals)
      .set({ status: "pending_review" })
      .where(eq(professionals.id, own.id));

    await recordAudit(
      {
        actor,
        action: "professional.submitted",
        resourceType: "professional",
        resourceId: own.id,
        after: { status: "pending_review" },
      },
      tx,
    );
  });

  return applicationById(own.id);
}

/** Pulling it back out of the queue to change something. */
export async function withdrawFromReview(actor: Actor): Promise<ApplicationView> {
  const own = await requireOwn(actor);
  if (own.status !== "pending_review") {
    throw new ApiError("conflict", "Nothing is under review.");
  }

  await db.update(professionals).set({ status: "draft" }).where(eq(professionals.id, own.id));
  return applicationById(own.id);
}

export async function myApplication(actor: Actor): Promise<ApplicationView> {
  const own = await requireOwn(actor);
  return applicationById(own.id);
}

/**
 * The whole application in one read.
 *
 * Also used by admin, which is why it decides nothing about who may see it — the
 * caller has already answered that. It never returns a decrypted value.
 */
export async function applicationById(professionalId: string): Promise<ApplicationView> {
  const [row] = await db
    .select()
    .from(professionals)
    .where(eq(professionals.id, professionalId))
    .limit(1);

  if (!row) throw new ApiError("not_found", "No such professional.");

  const [cats, creds, payout] = await Promise.all([
    db
      .select({ slug: categories.slug, label: categories.label })
      .from(professionalCategories)
      .innerJoin(categories, eq(categories.id, professionalCategories.categoryId))
      .where(eq(professionalCategories.professionalId, professionalId)),
    db
      .select({
        id: professionalCredentials.id,
        body: professionalCredentials.body,
        registrationNumber: professionalCredentials.registrationNumber,
        status: professionalCredentials.status,
        reviewNote: professionalCredentials.reviewNote,
      })
      .from(professionalCredentials)
      .where(eq(professionalCredentials.professionalId, professionalId)),
    db
      .select()
      .from(payoutIdentities)
      .where(eq(payoutIdentities.professionalId, professionalId))
      .limit(1),
  ]);

  const identity = payout[0];

  const readiness: ReadinessCheck[] = [
    {
      key: "categories",
      done: cats.length > 0,
      label: "at least one category you can take work in",
    },
    {
      key: "credential",
      done: creds.length > 0,
      label: "a registration number we can check against the public register",
    },
    {
      key: "payout",
      done: Boolean(identity),
      label: "bank and PAN details, so you can be paid",
    },
  ];

  return {
    id: row.id,
    kind: row.kind,
    displayName: row.displayName,
    headline: row.headline,
    city: row.city,
    status: row.status,
    available: row.available,
    concurrentCapacity: row.concurrentCapacity,
    categories: cats,
    credentials: creds,
    payout: identity
      ? {
          panMasked: maskPan(identity.panEncrypted),
          gstinSet: identity.gstinEncrypted !== null,
          accountLast4: identity.accountLast4,
          ifsc: identity.ifsc,
          accountHolderName: identity.accountHolderName,
        }
      : null,
    readiness,
    submittable: readiness.every((c) => c.done) && EDITABLE.includes(row.status),
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Admin's view of one application. */
export async function reviewApplication(
  actor: Actor,
  professionalId: string,
): Promise<ApplicationView> {
  authorize(actor, "professional.read", { minimumRole: "admin" });
  return applicationById(professionalId);
}
