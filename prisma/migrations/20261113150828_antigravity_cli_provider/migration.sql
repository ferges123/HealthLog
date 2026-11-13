-- AlterTable
ALTER TABLE "user" ADD COLUMN "antigravity_profile_id" TEXT;
ALTER TABLE "user" ADD COLUMN "antigravity_model" TEXT;
ALTER TABLE "user" ADD COLUMN "antigravity_connection_status" TEXT NOT NULL DEFAULT 'disconnected';
ALTER TABLE "user" ADD COLUMN "antigravity_connected_at" TIMESTAMPTZ(3);
ALTER TABLE "user" ADD COLUMN "antigravity_capabilities_json" JSONB;
