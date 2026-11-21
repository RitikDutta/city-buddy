ALTER TABLE "ShoppingItem" ADD COLUMN "request_id" TEXT;
CREATE UNIQUE INDEX "ShoppingItem_user_id_request_id_key" ON "ShoppingItem"("user_id", "request_id");
