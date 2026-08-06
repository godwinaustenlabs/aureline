import { drizzle } from "drizzle-orm/durable-sqlite";
import * as schema from "./schema";

export function getDb(storage: DurableObjectStorage) {
	return drizzle(storage, { schema });
}

export type HeliosDb = ReturnType<typeof getDb>;