CREATE TYPE "public"."credential_status" AS ENUM('submitted', 'verified', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."professional_kind" AS ENUM('chartered_accountant', 'company_secretary', 'advocate');--> statement-breakpoint
CREATE TYPE "public"."professional_status" AS ENUM('draft', 'pending_review', 'verified', 'suspended', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."assignment_status" AS ENUM('assigned', 'acknowledged', 'in_progress', 'awaiting_client', 'completed', 'declined', 'revoked', 'escalated');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'dispatching', 'dispatched', 'dead');--> statement-breakpoint
CREATE TABLE "payout_identities" (
	"professional_id" uuid PRIMARY KEY NOT NULL,
	"pan_encrypted" text NOT NULL,
	"gstin_encrypted" text,
	"account_number_encrypted" text NOT NULL,
	"ifsc" text NOT NULL,
	"account_holder_name" text NOT NULL,
	"account_last4" text NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payout_last4_shape" CHECK ("payout_identities"."account_last4" ~ '^[0-9]{4}$')
);
--> statement-breakpoint
CREATE TABLE "professional_categories" (
	"professional_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "professional_categories_professional_id_category_id_pk" PRIMARY KEY("professional_id","category_id")
);
--> statement-breakpoint
CREATE TABLE "professional_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"professional_id" uuid NOT NULL,
	"body" text NOT NULL,
	"registration_number" text NOT NULL,
	"document_key" text,
	"status" "credential_status" DEFAULT 'submitted' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "professionals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "professional_kind" NOT NULL,
	"display_name" text NOT NULL,
	"headline" text,
	"city" text,
	"status" "professional_status" DEFAULT 'draft' NOT NULL,
	"available" boolean DEFAULT false NOT NULL,
	"concurrent_capacity" integer DEFAULT 5 NOT NULL,
	"last_assigned_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "professionals_capacity_positive" CHECK ("professionals"."concurrent_capacity" > 0)
);
--> statement-breakpoint
CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"professional_id" uuid NOT NULL,
	"status" "assignment_status" DEFAULT 'assigned' NOT NULL,
	"acknowledge_by" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"attempt" integer DEFAULT 1 NOT NULL,
	"closed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"payload" jsonb,
	"dedupe_key" text NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "payout_identities" ADD CONSTRAINT "payout_identities_professional_id_professionals_id_fk" FOREIGN KEY ("professional_id") REFERENCES "public"."professionals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_categories" ADD CONSTRAINT "professional_categories_professional_id_professionals_id_fk" FOREIGN KEY ("professional_id") REFERENCES "public"."professionals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_categories" ADD CONSTRAINT "professional_categories_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_credentials" ADD CONSTRAINT "professional_credentials_professional_id_professionals_id_fk" FOREIGN KEY ("professional_id") REFERENCES "public"."professionals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_credentials" ADD CONSTRAINT "professional_credentials_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professionals" ADD CONSTRAINT "professionals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_professional_id_professionals_id_fk" FOREIGN KEY ("professional_id") REFERENCES "public"."professionals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "professional_categories_category_idx" ON "professional_categories" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "professional_credentials_pro_idx" ON "professional_credentials" USING btree ("professional_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "professionals_user_uq" ON "professionals" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "professionals_assignable_idx" ON "professionals" USING btree ("last_assigned_at") WHERE "professionals"."status" = 'verified' AND "professionals"."available";--> statement-breakpoint
CREATE INDEX "professionals_status_idx" ON "professionals" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "assignments_one_open_per_order_uq" ON "assignments" USING btree ("order_id") WHERE "assignments"."status" IN ('assigned', 'acknowledged', 'in_progress', 'awaiting_client');--> statement-breakpoint
CREATE INDEX "assignments_professional_idx" ON "assignments" USING btree ("professional_id","status");--> statement-breakpoint
CREATE INDEX "assignments_order_idx" ON "assignments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "assignments_overdue_idx" ON "assignments" USING btree ("acknowledge_by") WHERE "assignments"."status" = 'assigned';--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_dedupe_uq" ON "outbox_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "outbox_claim_idx" ON "outbox_events" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "outbox_aggregate_idx" ON "outbox_events" USING btree ("aggregate_type","aggregate_id");