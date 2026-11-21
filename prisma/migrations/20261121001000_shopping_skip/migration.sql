BEGIN TRANSACTION;

CREATE TABLE "new_ShoppingItem" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "user_id" TEXT NOT NULL REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "name" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1 CHECK("quantity" BETWEEN 1 AND 9999),
  "notes" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'pending' CHECK("status" IN ('pending','purchased','skipped')),
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL
);

INSERT INTO "new_ShoppingItem" ("id", "user_id", "name", "quantity", "notes", "status", "created_at", "updated_at")
SELECT "id", "user_id", "name", "quantity", "notes", "status", "created_at", "updated_at" FROM "ShoppingItem";

DROP TABLE "ShoppingItem";
ALTER TABLE "new_ShoppingItem" RENAME TO "ShoppingItem";
CREATE INDEX "ShoppingItem_user_id_created_at_idx" ON "ShoppingItem"("user_id", "created_at");

COMMIT;
