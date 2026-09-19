import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { orders, type OrderStatus } from "../../db/schema/index.js";
import { ApiError, type Page } from "../../lib/api.js";
import { recordAudit } from "../../lib/auth/audit.js";
import { authorize, ownsOrAdmin, type Actor } from "../../lib/auth/policy.js";
import { formatOrderReference, nextCounterValue } from "../../lib/counters.js";
import { decodeCursor, encodeCursor, toPage } from "../../lib/pagination.js";
import { findServiceForPurchase } from "../catalogue/repository.js";

/**
 * Orders.
 *
 * An order records what was sold at the price it was sold for. M1 stops at
 * `payment_pending`; M2 takes it from there on a confirmed gateway webhook.
 */

export type OrderView = {
  reference: string;
  status: OrderStatus;
  serviceTitle: string;
  serviceSlug: string;
  categorySlug: string;
  fulfilmentType: "service" | "consultation";
  pricePaise: number;
  currency: string;
  turnaroundDays: number | null;
  createdAt: Date;
};

const VIEW = {
  reference: orders.reference,
  status: orders.status,
  serviceTitle: orders.serviceTitle,
  serviceSlug: orders.serviceSlug,
  categorySlug: orders.categorySlug,
  fulfilmentType: orders.fulfilmentType,
  pricePaise: orders.pricePaise,
  currency: orders.currency,
  turnaroundDays: orders.turnaroundDays,
  createdAt: orders.createdAt,
};

export async function createOrder(
  actor: Actor,
  categorySlug: string,
  serviceSlug: string,
): Promise<OrderView> {
  authorize(actor, "order.create");

  const service = await findServiceForPurchase(categorySlug, serviceSlug);

  // Same message for "no such service" and "withdrawn from sale": which services are
  // drafted or retired is not public information.
  if (!service || !service.active || !service.categoryActive) {
    throw new ApiError("not_found", "That service is not available.");
  }

  // Bound to a local before the transaction: TypeScript discards narrowing of a
  // property once it is read inside a closure, and this must stay non-null all the way
  // into the insert.
  const pricePaise = service.pricePaise;

  // Defensive: the services_priced_when_active CHECK already guarantees this, so
  // reaching it means the constraint was dropped. Better a 409 than an order at ₹0.
  if (pricePaise === null) {
    throw new ApiError("conflict", "That service is not priced yet.");
  }

  return db.transaction(async (tx) => {
    // Allocated inside the transaction, so a failure below rolls the counter back
    // rather than leaving a hole in the reference series.
    const reference = formatOrderReference(await nextCounterValue("order_reference", tx));

    const [created] = await tx
      .insert(orders)
      .values({
        reference,
        userId: actor.userId,
        serviceId: service.id,
        categoryId: service.categoryId,
        // Copied, not referenced. Repricing the catalogue tomorrow must not alter what
        // this client agreed to pay today — the invoice and the ledger both key off it.
        serviceSlug: service.slug,
        categorySlug: service.categorySlug,
        serviceTitle: service.title,
        fulfilmentType: service.fulfilmentType,
        pricePaise,
        currency: service.currency,
        turnaroundDays: service.turnaroundDays,
      })
      .returning(VIEW);

    if (!created) throw new ApiError("internal", "Could not create the order.");

    await recordAudit(
      {
        actor,
        action: "order.created",
        resourceType: "order",
        resourceId: created.reference,
        after: { service: service.slug, category: service.categorySlug, price: pricePaise },
      },
      tx,
    );

    return created;
  });
}

export async function listOrdersFor(
  actor: Actor,
  options: { cursor?: string; limit: number },
): Promise<Page<OrderView>> {
  const filters = [eq(orders.userId, actor.userId)];

  if (options.cursor) {
    const [createdAt, id] = decodeCursor(options.cursor, 2);
    // Newest first, so the keyset moves backwards. Paired with id because two orders
    // can share a timestamp.
    filters.push(
      sql`(${orders.createdAt}, ${orders.id}) < (${createdAt}::timestamptz, ${id}::uuid)`,
    );
  }

  const rows = await db
    .select({ ...VIEW, id: orders.id })
    .from(orders)
    .where(and(...filters))
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(options.limit + 1);

  const page = toPage(rows, options.limit, (row) =>
    encodeCursor([row.createdAt.toISOString(), row.id]),
  );

  return {
    items: page.items.map(({ id: _id, ...rest }) => rest),
    nextCursor: page.nextCursor,
  };
}

export async function findOrder(actor: Actor, reference: string): Promise<OrderView> {
  const [row] = await db
    .select({ ...VIEW, userId: orders.userId })
    .from(orders)
    .where(eq(orders.reference, reference))
    .limit(1);

  if (!row) throw new ApiError("not_found", "No such order.");

  /**
   * Admin may read any order; a client may read only their own — and a client asking
   * for someone else's gets **not_found, not forbidden**. A 403 would confirm that the
   * reference exists, and references are sequential: LX-000141 is one below LX-000142.
   * Walking them would reveal exactly how many orders the platform has taken.
   */
  if (!ownsOrAdmin(actor, row.userId)) throw new ApiError("not_found", "No such order.");

  const { userId: _userId, ...order } = row;
  return order;
}

export { asc };
