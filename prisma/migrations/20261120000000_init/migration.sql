CREATE TABLE "User" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "identity_hash" TEXT NOT NULL,
  "selected_location" JSONB,
  "location_candidates" JSONB,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "User_identity_hash_key" ON "User"("identity_hash");
CREATE TABLE "ShoppingItem" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "user_id" TEXT NOT NULL REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "name" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1 CHECK("quantity" BETWEEN 1 AND 9999),
  "notes" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'pending' CHECK("status" IN ('pending','purchased')),
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL
);
CREATE INDEX "ShoppingItem_user_id_created_at_idx" ON "ShoppingItem"("user_id","created_at");
CREATE TABLE "ChatSession" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "user_id" TEXT NOT NULL REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "mode" TEXT NOT NULL CHECK("mode" IN ('my_items','live_talk','on_site_guide')),
  "status" TEXT NOT NULL DEFAULT 'active' CHECK("status" IN ('active','ended')),
  "selected_location" JSONB,
  "context" JSONB,
  "turn_token" TEXT,
  "turn_expires_at" DATETIME,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL
);
CREATE INDEX "ChatSession_user_id_mode_updated_at_idx" ON "ChatSession"("user_id","mode","updated_at");
CREATE UNIQUE INDEX "ChatSession_active_mode" ON "ChatSession"("user_id","mode") WHERE "status"='active';
CREATE TABLE "ChatMessage" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "session_id" TEXT NOT NULL REFERENCES "ChatSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "role" TEXT NOT NULL CHECK("role" IN ('user','assistant')),
  "content" TEXT NOT NULL,
  "relevant_tool_metadata" JSONB,
  "request_id" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ChatMessage_session_id_request_id_role_key" ON "ChatMessage"("session_id","request_id","role");
CREATE INDEX "ChatMessage_session_id_created_at_idx" ON "ChatMessage"("session_id","created_at");
