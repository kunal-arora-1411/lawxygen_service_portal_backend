import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  assignments,
  OPEN_ASSIGNMENT_STATUSES,
  orders,
  payoutIdentities,
  professionalCategories,
  professionals,
  users,
  type OrderStatus,
  type ProfessionalStatus,
} from "../../db/schema/index.js";
import { type Page } from "../../lib/api.js";
import { authorize, type Actor } from "../../lib/auth/policy.js";
import { decodeCursor, encodeCursor, toPage } from "../../lib/pagination.js";

/** Read models for the admin console. */

export type AdminProfessional = {
  id: string;
  displayName: string;
  kind: string;
  status: ProfessionalStatus;
  available: boolean;
  city: string | null;
  email: string | null;
  phone: string | null;
  categories: string[];
  concurrentCapacity: number;
  openMatters: number;
  /** Without one they cannot be paid, so the engine skips them however verified. */
  hasPayoutIdentity: boolean;
  createdAt: Date;
};

export async function listProfessionals(
  actor: Actor,
  options: { status?: ProfessionalStatus },
): Promise<AdminProfessional[]> {
  authorize(actor, "professional.read", { minimumRole: "admin" });

  const rows = await db
    .select({
      id: professionals.id,
      displayName: professionals.displayName,
      kind: professionals.kind,
      status: professionals.status,
      available: professionals.available,
      city: professionals.city,
      concurrentCapacity: professionals.concurrentCapacity,
      createdAt: professionals.createdAt,
      email: users.email,
      phone: users.phone,
      hasPayoutIdentity: sql<boolean>`${payoutIdentities.professionalId} is not null`,
      openMatters: sql<number>`(
        select count(*) from ${assignments} a
        where a.professional_id = ${professionals.id}
          and a.status in ${sql.raw(`(${OPEN_ASSIGNMENT_STATUSES.map((s) => `'${s}'`).join(", ")})`)}
      )::int`,
      categories: sql<string[]>`coalesce((
        select array_agg(c.slug order by c.slug)
        from ${professionalCategories} pc
        join categories c on c.id = pc.category_id
        where pc.professional_id = ${professionals.id}
      ), '{}')`,
    })
    .from(professionals)
    .innerJoin(users, eq(users.id, professionals.userId))
    .leftJoin(payoutIdentities, eq(payoutIdentities.professionalId, professionals.id))
    .where(options.status ? eq(professionals.status, options.status) : undefined)
    .orderBy(desc(professionals.createdAt));

  return rows;
}

export type AdminOrder = {
  reference: string;
  status: OrderStatus;
  serviceTitle: string;
  categorySlug: string;
  pricePaise: number;
  currency: string;
  createdAt: Date;
  clientName: string | null;
  clientEmail: string | null;
  professionalName: string | null;
  /** Null until acknowledged; past means the escalation sweep will pick it up. */
  acknowledgeBy: Date | null;
};

export async function listOrders(
  actor: Actor,
  options: { status?: OrderStatus; cursor?: string; limit: number },
): Promise<Page<AdminOrder>> {
  authorize(actor, "order.read.all", { minimumRole: "admin" });

  const filters: (SQL | undefined)[] = [];
  if (options.status) filters.push(eq(orders.status, options.status));
  if (options.cursor) {
    const [createdAt, id] = decodeCursor(options.cursor, 2);
    filters.push(
      sql`(${orders.createdAt}, ${orders.id}) < (${createdAt}::timestamptz, ${id}::uuid)`,
    );
  }

  const rows = await db
    .select({
      id: orders.id,
      reference: orders.reference,
      status: orders.status,
      serviceTitle: orders.serviceTitle,
      categorySlug: orders.categorySlug,
      pricePaise: orders.pricePaise,
      currency: orders.currency,
      createdAt: orders.createdAt,
      clientName: users.name,
      clientEmail: users.email,
      professionalName: professionals.displayName,
      acknowledgeBy: assignments.acknowledgeBy,
    })
    .from(orders)
    .innerJoin(users, eq(users.id, orders.userId))
    // Only the open assignment, so a reassigned order shows who holds it now rather
    // than one row per attempt.
    .leftJoin(
      assignments,
      and(
        eq(assignments.orderId, orders.id),
        inArray(assignments.status, [...OPEN_ASSIGNMENT_STATUSES]),
      ),
    )
    .leftJoin(professionals, eq(professionals.id, assignments.professionalId))
    .where(filters.length ? and(...filters) : undefined)
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

export type Overview = {
  orders: { total: number; today: number; awaitingAssignment: number; escalated: number };
  revenuePaise: { today: number; allTime: number };
  professionals: { verified: number; pendingReview: number; available: number };
};

/**
 * The numbers on the admin home.
 *
 * Revenue counts orders that have actually been paid, not orders created — an
 * abandoned checkout is not income, and a dashboard that says otherwise is worse than
 * one that says nothing.
 */
export async function overview(actor: Actor): Promise<Overview> {
  authorize(actor, "analytics.read", { minimumRole: "admin" });

  const paid: OrderStatus[] = [
    "paid",
    "awaiting_assignment",
    "assigned",
    "assignment_escalated",
    "in_progress",
    "awaiting_client",
    "completed",
  ];

  /**
   * `inArray`, not `= any(${paid})`.
   *
   * Interpolating a JavaScript array into a template expands it to a *tuple* —
   * `($1, $2, …)` — and `ANY` requires an array on its right side, so the query fails
   * outright with "op ANY/ALL (array) requires array on right side". `inArray` emits
   * `status in (…)`, which is what was meant.
   */
  const isPaid = inArray(orders.status, paid);
  const todayIST = sql`${orders.createdAt} >= date_trunc('day', now() at time zone 'Asia/Kolkata')`;

  const [orderStats] = await db
    .select({
      total: sql<number>`count(*)::int`,
      today: sql<number>`count(*) filter (where ${todayIST})::int`,
      awaitingAssignment: sql<number>`count(*) filter (
        where ${orders.status} = 'awaiting_assignment'
      )::int`,
      escalated: sql<number>`count(*) filter (
        where ${orders.status} = 'assignment_escalated'
      )::int`,
      revenueAllTime: sql<number>`coalesce(sum(${orders.pricePaise}) filter (
        where ${isPaid}
      ), 0)::bigint`,
      revenueToday: sql<number>`coalesce(sum(${orders.pricePaise}) filter (
        where ${isPaid} and ${todayIST}
      ), 0)::bigint`,
    })
    .from(orders);

  const [proStats] = await db
    .select({
      verified: sql<number>`count(*) filter (where ${professionals.status} = 'verified')::int`,
      pendingReview: sql<number>`count(*) filter (
        where ${professionals.status} = 'pending_review'
      )::int`,
      available: sql<number>`count(*) filter (
        where ${professionals.status} = 'verified' and ${professionals.available}
      )::int`,
    })
    .from(professionals);

  return {
    orders: {
      total: orderStats?.total ?? 0,
      today: orderStats?.today ?? 0,
      awaitingAssignment: orderStats?.awaitingAssignment ?? 0,
      escalated: orderStats?.escalated ?? 0,
    },
    revenuePaise: {
      today: Number(orderStats?.revenueToday ?? 0),
      allTime: Number(orderStats?.revenueAllTime ?? 0),
    },
    professionals: {
      verified: proStats?.verified ?? 0,
      pendingReview: proStats?.pendingReview ?? 0,
      available: proStats?.available ?? 0,
    },
  };
}
