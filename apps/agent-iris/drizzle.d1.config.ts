import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  // Iris's own migrations directory, not Helios's. wrangler.jsonc's
  // migrations_dir points at this same path and the two must not drift.
  out: "../../infrastructure/d1/migrations/iris",
});
