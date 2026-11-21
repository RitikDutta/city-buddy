import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

if (existsSync(".env")) process.loadEnvFile(".env");
const url = (process.env.DATABASE_URL ||= "file:./dev.db");
if (url.startsWith("file:")) {
  const value = url.split("?")[0].slice(5);
  const schemaDir = fileURLToPath(new URL("../prisma/", import.meta.url));
  const path = value.startsWith("//") ? fileURLToPath(url) : resolve(schemaDir, decodeURIComponent(value));
  mkdirSync(dirname(path), { recursive: true });
  // Prisma's SQLite migration engine expects the file to exist on a fresh checkout.
  closeSync(openSync(path, "a"));
}
const result = spawnSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], {
  stdio: "inherit", env: process.env,
});
process.exit(result.status ?? 1);
