import { drizzle } from "drizzle-orm/durable-sqlite";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import * as schema from "./schema";
import * as d1Schema from "./schema.d1";

export function getDb(storage: DurableObjectStorage) {
	return drizzle(storage, { schema });
}

export type HeliosDb = ReturnType<typeof getDb>;

/**
 * The D1 client sees `schema.d1.ts` as well, and `getDb` above deliberately
 * does not. The tables in that file exist only in D1 — registering them on the
 * Durable Object's client would offer a query surface for tables that are not
 * in its migration and do not exist in its storage.
 */
export function getD1Db(db: D1Database) {
	return drizzleD1(db, { schema: { ...schema, ...d1Schema } });
}

export type HeliosD1Db = ReturnType<typeof getD1Db>;
