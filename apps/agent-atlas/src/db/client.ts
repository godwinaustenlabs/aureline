import { drizzle } from "drizzle-orm/durable-sqlite";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import * as schema from "./schema";

/**
 * Two factories over one schema, returning different types on purpose so it is
 * hard to hand a D1 client to something expecting the Durable Object's storage.
 */

export function getDb(storage: DurableObjectStorage) {
	return drizzle(storage, { schema });
}

export type AtlasDb = ReturnType<typeof getDb>;

export function getD1Db(db: D1Database) {
	return drizzleD1(db, { schema });
}

export type AtlasD1Db = ReturnType<typeof getD1Db>;
