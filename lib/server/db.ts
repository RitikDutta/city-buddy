import { PrismaClient } from "@prisma/client";

const shared = globalThis as typeof globalThis & { cityBuddyDb?: PrismaClient };
export const db =
  shared.cityBuddyDb ??
  new PrismaClient({
    datasourceUrl: process.env.DATABASE_URL || "file:./dev.db",
  });
if (process.env.NODE_ENV !== "production") shared.cityBuddyDb = db;
