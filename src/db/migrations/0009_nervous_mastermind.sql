CREATE TYPE "public"."whatsapp_conversation_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."whatsapp_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TABLE "whatsapp_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_number_id" text NOT NULL,
	"contact_phone" text NOT NULL,
	"contact_name" text,
	"user_id" uuid,
	"status" "whatsapp_conversation_status" DEFAULT 'open' NOT NULL,
	"assigned_user_id" uuid,
	"assigned_at" timestamp with time zone,
	"last_inbound_at" timestamp with time zone,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" "whatsapp_direction" NOT NULL,
	"meta_message_id" text,
	"type" text DEFAULT 'text' NOT NULL,
	"body" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"send_attempt_id" uuid,
	"sent_by_user_id" uuid,
	"status" text,
	"failed_reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "whatsapp_conversations" ADD CONSTRAINT "whatsapp_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_conversations" ADD CONSTRAINT "whatsapp_conversations_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_conversation_id_whatsapp_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."whatsapp_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_send_attempt_id_whatsapp_send_attempts_id_fk" FOREIGN KEY ("send_attempt_id") REFERENCES "public"."whatsapp_send_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_sent_by_user_id_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_conversations_pair_uq" ON "whatsapp_conversations" USING btree ("phone_number_id","contact_phone");--> statement-breakpoint
CREATE INDEX "whatsapp_conversations_user_idx" ON "whatsapp_conversations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "whatsapp_conversations_assigned_idx" ON "whatsapp_conversations" USING btree ("assigned_user_id","status");--> statement-breakpoint
CREATE INDEX "whatsapp_conversations_recent_idx" ON "whatsapp_conversations" USING btree ("last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_messages_meta_id_uq" ON "whatsapp_messages" USING btree ("meta_message_id");--> statement-breakpoint
CREATE INDEX "whatsapp_messages_thread_idx" ON "whatsapp_messages" USING btree ("conversation_id","occurred_at");