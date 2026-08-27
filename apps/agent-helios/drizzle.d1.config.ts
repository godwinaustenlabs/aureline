import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  // Helios's own migrations directory, not the root of `migrations/`.
  // wrangler.jsonc's migrations_dir points at this same path and the two must
  // not drift. It used to be the parent directory, which made Iris's
  // `migrations/iris/` a child of Helios's own migrations directory.
  out: "../../infrastructure/d1/migrations/helios",
});
