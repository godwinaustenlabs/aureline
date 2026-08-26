import { drizzle } from "drizzle-orm/durable-sqlite";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb(storage: DurableObjectStorage) {
	return drizzle(storage, { schema });
}

export type IrisDb = ReturnType<typeof getDb>;

export function getD1Db(db: D1Database) {
	return drizzleD1(db, { schema });
}

export type IrisD1Db = ReturnType<typeof getD1Db>;
