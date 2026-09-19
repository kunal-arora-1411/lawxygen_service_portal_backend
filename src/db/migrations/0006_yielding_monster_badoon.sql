CREATE TABLE "reconciliation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"gateway_count" integer DEFAULT 0 NOT NULL,
	"matched_count" integer DEFAULT 0 NOT NULL,
	"repaired_count" integer DEFAULT 0 NOT NULL,
	"exceptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ledger_imbalance_paise" bigint DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"failure_reason" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "reconciliation_runs_window_idx" ON "reconciliation_runs" USING btree ("window_start");--> statement-breakpoint
CREATE INDEX "reconciliation_runs_started_idx" ON "reconciliation_runs" USING btree ("started_at");