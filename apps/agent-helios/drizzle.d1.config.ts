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
  // Helios's own migrations directory, not the root of `migrations/`.
  // wrangler.jsonc's migrations_dir points at this same path and the two must
  // not drift. It used to be the parent directory, which made Iris's
  // `migrations/iris/` a child of Helios's own migrations directory.
  out: "../../infrastructure/d1/migrations/helios",
});
