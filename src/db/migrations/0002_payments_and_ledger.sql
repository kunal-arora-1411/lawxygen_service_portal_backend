CREATE TYPE "public"."ledger_direction" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_kind" AS ENUM('capture', 'refund', 'payout', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('created', 'authorized', 'captured', 'failed', 'refunded');--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"number" text NOT NULL,
	"financial_year" text NOT NULL,
	"sequence" integer NOT NULL,
	"gross_paise" bigint NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"gst_paise" bigint NOT NULL,
	"gst_rate_bps" integer NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"place_of_supply" text,
	"supplier_gstin" text,
	"buyer_gstin" text,
	"sac_code" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_totals_balance" CHECK ("invoices"."taxable_paise" + "invoices"."gst_paise" = "invoices"."gross_paise")
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "ledger_entry_kind" NOT NULL,
	"source_ref" text NOT NULL,
	"order_id" uuid,
	"currency" text DEFAULT 'INR' NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"memo" text
);
--> statement-breakpoint
CREATE TABLE "ledger_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"account" text NOT NULL,
	"direction" "ledger_direction" NOT NULL,
	"amount_paise" bigint NOT NULL,
	"subject_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_lines_amount_positive" CHECK ("ledger_lines"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" text DEFAULT 'razorpay' NOT NULL,
	"provider_order_id" text NOT NULL,
	"provider_payment_id" text,
	"amount_paise" bigint NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"status" "payment_status" DEFAULT 'created' NOT NULL,
	"method" text,
	"error_code" text,
	"error_description" text,
	"captured_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_non_negative" CHECK ("payments"."amount_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text DEFAULT 'razorpay' NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_lines" ADD CONSTRAINT "ledger_lines_entry_id_ledger_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_number_uq" ON "invoices" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_order_uq" ON "invoices" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_year_sequence_uq" ON "invoices" USING btree ("financial_year","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_kind_source_uq" ON "ledger_entries" USING btree ("kind","source_ref");--> statement-breakpoint
CREATE INDEX "ledger_entries_order_idx" ON "ledger_entries" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_occurred_idx" ON "ledger_entries" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "ledger_lines_entry_idx" ON "ledger_lines" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "ledger_lines_account_idx" ON "ledger_lines" USING btree ("account","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_order_uq" ON "payments" USING btree ("provider","provider_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_payment_uq" ON "payments" USING btree ("provider","provider_payment_id") WHERE "payments"."provider_payment_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payments_order_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_event_id_uq" ON "webhook_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "webhook_events_unprocessed_idx" ON "webhook_events" USING btree ("received_at") WHERE "webhook_events"."processed_at" IS NULL;