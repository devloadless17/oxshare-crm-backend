CREATE TABLE "kyc_submission_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"status" "kyc_status" NOT NULL,
	"personal_info" jsonb,
	"document" jsonb,
	"selfie" jsonb,
	"address_proof" jsonb,
	"rejection_reason" text,
	"rejected_fields" jsonb,
	"submitted_at" timestamp with time zone,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kyc_submission_attempts" ADD CONSTRAINT "kyc_submission_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_submission_attempts" ADD CONSTRAINT "kyc_submission_attempts_reviewed_by_admins_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kyc_attempts_user_idx" ON "kyc_submission_attempts" USING btree ("user_id","attempt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "kyc_attempts_user_attempt_uq" ON "kyc_submission_attempts" USING btree ("user_id","attempt_no");