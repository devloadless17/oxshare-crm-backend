CREATE TABLE "platform_links" (
	"key" varchar(32) PRIMARY KEY NOT NULL,
	"url" varchar(2048),
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
