-- ADM-14 client tagging, and the row-level client visibility built on top of it.
--
-- Three tables and four columns, but only two facts matter when reading this
-- back later, and both are the kind that look like typos:
--
-- 1. `admin_client_tag_scopes.tag_id` is ON DELETE **RESTRICT**, while
--    `client_tag_assignments.tag_id` is ON DELETE **CASCADE**. Not an
--    inconsistency. An empty scope means UNRESTRICTED (the RBAC-08 / D-10
--    precedent: a deploy must not blind every existing sub-admin). So with
--    CASCADE, deleting a tag would delete the last scope row of every admin
--    restricted to it and PROMOTE THEM TO SEEING EVERY CLIENT — privilege
--    escalation performed by a DELETE on a label, leaving nothing in the audit
--    trail that resembles a permission change. RESTRICT makes "you cannot
--    delete a tag that is somebody's territory" the database's rule. An
--    assignment carries no such authority, so it cascades.
--
-- 2. `admins.masked_fields` is NULLABLE while `roles.masked_fields` is
--    NOT NULL DEFAULT '[]'. Also not an inconsistency. NULL on the admin means
--    "inherit the role", an array means "override this person" — so unmasking
--    one field for one person does not require detaching them from their role,
--    which would silently stop them receiving role permission updates. On the
--    role, `[]` is exactly today's behaviour, which is what makes this
--    migration incapable of blinding anybody on deploy.
--
-- `admin_invites.scoped_tag_ids` exists so a territory can be chosen at INVITE
-- time. Without it, an accepted sub-admin would see every client in the system
-- during the window between clicking the emailed link and a master admin
-- remembering to configure them — a window nobody would ever observe.

CREATE TABLE "admin_client_tag_scopes" (
	"admin_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_client_tag_scopes_admin_id_tag_id_pk" PRIMARY KEY("admin_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "client_tag_assignments" (
	"user_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"assigned_by" uuid,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_tag_assignments_user_id_tag_id_pk" PRIMARY KEY("user_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "client_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(64) NOT NULL,
	"label" varchar(100) NOT NULL,
	"color" varchar(32),
	"description" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_invites" ADD COLUMN "masked_fields" jsonb;--> statement-breakpoint
ALTER TABLE "admin_invites" ADD COLUMN "scoped_tag_ids" jsonb;--> statement-breakpoint
ALTER TABLE "admins" ADD COLUMN "masked_fields" jsonb;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "masked_fields" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_client_tag_scopes" ADD CONSTRAINT "admin_client_tag_scopes_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_client_tag_scopes" ADD CONSTRAINT "admin_client_tag_scopes_tag_id_client_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."client_tags"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_tag_assignments" ADD CONSTRAINT "client_tag_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_tag_assignments" ADD CONSTRAINT "client_tag_assignments_tag_id_client_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."client_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_tag_assignments_tag_idx" ON "client_tag_assignments" USING btree ("tag_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "client_tags_slug_uq" ON "client_tags" USING btree ("slug");