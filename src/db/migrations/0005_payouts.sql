CREATE TYPE "public"."payout_batch_status" AS ENUM('draft', 'releasing', 'released', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('pending', 'paid', 'failed', 'skipped');--> statement-breakpoint
CREATE TABLE "payout_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"status" "payout_batch_status" DEFAULT 'draft' NOT NULL,
	"total_paise" bigint DEFAULT 0 NOT NULL,
	"payout_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"released_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"note" text,
	CONSTRAINT "payout_batches_total_non_negative" CHECK ("payout_batches"."total_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"professional_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"tds_paise" bigint DEFAULT 0 NOT NULL,
	"tds_section" text,
	"tds_rate_bps" integer,
	"status" "payout_status" DEFAULT 'pending' NOT NULL,
	"provider_ref" text,
	"failure_reason" text,
	"account_last4" text,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_amount_positive" CHECK ("payouts"."amount_paise" > 0)
);
--> statement-breakpoint
ALTER TABLE "payout_batches" ADD CONSTRAINT "payout_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_batches" ADD CONSTRAINT "payout_batches_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_batch_id_payout_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."payout_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_professional_id_professionals_id_fk" FOREIGN KEY ("professional_id") REFERENCES "public"."professionals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payout_batches_reference_uq" ON "payout_batches" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "payout_batches_status_idx" ON "payout_batches" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_batch_professional_uq" ON "payouts" USING btree ("batch_id","professional_id");--> statement-breakpoint
CREATE INDEX "payouts_professional_idx" ON "payouts" USING btree ("professional_id","created_at");--> statement-breakpoint
CREATE INDEX "payouts_status_idx" ON "payouts" USING btree ("status");