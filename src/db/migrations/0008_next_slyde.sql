CREATE TYPE "public"."whatsapp_send_status" AS ENUM('sending', 'accepted', 'failed_retryable', 'failed', 'delivery_unknown');--> statement-breakpoint
CREATE TYPE "public"."whatsapp_template_category" AS ENUM('utility', 'authentication', 'marketing');--> statement-breakpoint
CREATE TYPE "public"."whatsapp_template_status" AS ENUM('draft', 'pending', 'approved', 'rejected', 'paused', 'disabled');--> statement-breakpoint
CREATE TABLE "whatsapp_cooldowns" (
	"key" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_send_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"source" text NOT NULL,
	"phone_number_id" text NOT NULL,
	"recipient_phone" text NOT NULL,
	"template_name" text,
	"template_language" text,
	"template_category" "whatsapp_template_category",
	"order_id" uuid,
	"user_id" uuid,
	"sent_by_user_id" uuid,
	"payload" jsonb NOT NULL,
	"status" "whatsapp_send_status" DEFAULT 'sending' NOT NULL,
	"owner_token" uuid,
	"meta_message_id" text,
	"last_error" text,
	"failure_kind" text,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"category" "whatsapp_template_category" DEFAULT 'utility' NOT NULL,
	"status" "whatsapp_template_status" DEFAULT 'draft' NOT NULL,
	"provider_template_id" text,
	"components" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"review_note" text,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "whatsapp_send_attempts" ADD CONSTRAINT "whatsapp_send_attempts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_send_attempts" ADD CONSTRAINT "whatsapp_send_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_send_attempts" ADD CONSTRAINT "whatsapp_send_attempts_sent_by_user_id_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "whatsapp_cooldowns_expiry_idx" ON "whatsapp_cooldowns" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_send_attempts_idempotency_uq" ON "whatsapp_send_attempts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "whatsapp_send_attempts_order_idx" ON "whatsapp_send_attempts" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "whatsapp_send_attempts_status_idx" ON "whatsapp_send_attempts" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "whatsapp_send_attempts_unsettled_idx" ON "whatsapp_send_attempts" USING btree ("created_at") WHERE "whatsapp_send_attempts"."status" in ('delivery_unknown', 'failed_retryable');--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_templates_name_lang_uq" ON "whatsapp_templates" USING btree ("name","language");--> statement-breakpoint
CREATE INDEX "whatsapp_templates_status_idx" ON "whatsapp_templates" USING btree ("status");