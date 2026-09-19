CREATE TYPE "public"."fulfilment_type" AS ENUM('service', 'consultation');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('payment_pending', 'payment_failed', 'paid', 'awaiting_assignment', 'assigned', 'assignment_escalated', 'in_progress', 'awaiting_client', 'completed', 'cancelled', 'refunded');--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"accent" text,
	"position" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"fulfilment_type" "fulfilment_type" DEFAULT 'service' NOT NULL,
	"price_paise" bigint,
	"currency" text DEFAULT 'INR' NOT NULL,
	"turnaround_days" integer,
	"active" boolean DEFAULT false NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "services_priced_when_active" CHECK (NOT "services"."active" OR ("services"."price_paise" IS NOT NULL AND "services"."turnaround_days" IS NOT NULL)),
	CONSTRAINT "services_price_non_negative" CHECK ("services"."price_paise" IS NULL OR "services"."price_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "counters" (
	"name" text PRIMARY KEY NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"user_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"service_slug" text NOT NULL,
	"category_slug" text NOT NULL,
	"service_title" text NOT NULL,
	"fulfilment_type" "fulfilment_type" NOT NULL,
	"price_paise" bigint NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"turnaround_days" integer,
	"status" "order_status" DEFAULT 'payment_pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_price_non_negative" CHECK ("orders"."price_paise" >= 0)
);
--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_slug_uq" ON "categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "categories_position_idx" ON "categories" USING btree ("position");--> statement-breakpoint
CREATE UNIQUE INDEX "services_category_slug_uq" ON "services" USING btree ("category_id","slug");--> statement-breakpoint
CREATE INDEX "services_active_idx" ON "services" USING btree ("active","category_id","position");--> statement-breakpoint
CREATE INDEX "services_featured_idx" ON "services" USING btree ("featured") WHERE "services"."featured";--> statement-breakpoint
CREATE UNIQUE INDEX "orders_reference_uq" ON "orders" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "orders_user_created_idx" ON "orders" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status","created_at");