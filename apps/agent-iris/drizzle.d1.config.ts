import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  /**
   * **Both** schema files, and the DO config next door reads only the first.
   * `schema.d1.ts` holds the tables that exist in D1 alone — a table listed
   * there must never reach the Durable Object's own SQLite, where it would be a
   * separate empty copy per instance.
   */
  schema: ["./src/db/schema.ts", "./src/db/schema.d1.ts"],
  // Iris's own migrations directory, not Helios's. wrangler.jsonc's
  // migrations_dir points at this same path and the two must not drift.
  out: "../../infrastructure/d1/migrations/iris",
});
