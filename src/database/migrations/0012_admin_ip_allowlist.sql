-- RBAC-08 · admin IP allowlist, and the audit log's missing "from where".
--
-- AN EMPTY TABLE MEANS THE FEATURE IS OFF. That is deliberate and load-bearing:
-- this migration must not lock every administrator out of the system before
-- anyone can add a rule (DECISIONS D-10). Enforcement begins with the first row,
-- added by someone who can still reach the screen.
--
-- `cidr` is stored canonicalised (a bare address as /32, host bits dropped), so
-- 10.0.0.5/24 and 10.0.0.0/24 cannot both exist and leave an operator believing
-- they removed a rule that is still in force. The unique index enforces it.
--
-- audit_log.ip_address is nullable because it is genuinely unknown for anything
-- not driven by a request — a scheduled job, a migration, a console. A
-- placeholder there would read as an answer.

CREATE TABLE "admin_ip_allowlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cidr" varchar(43) NOT NULL,
	"label" varchar(200) NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "ip_address" varchar(45);--> statement-breakpoint
CREATE UNIQUE INDEX "admin_ip_allowlist_cidr_uq" ON "admin_ip_allowlist" USING btree ("cidr");