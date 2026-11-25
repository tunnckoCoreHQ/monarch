import { drizzle } from "drizzle-orm/d1";

import * as schema from "./drizzle-schema";

function createDatabase(binding: D1Database) {
  return drizzle(binding, { schema });
}

export type TriadDatabase = ReturnType<typeof createDatabase>;

const databases = new WeakMap<D1Database, TriadDatabase>();

// Better Auth and Triad's own queries share one Drizzle database per D1 binding.
export function triadDatabase(binding: D1Database): TriadDatabase {
  let database = databases.get(binding);
  if (!database) {
    database = createDatabase(binding);
    databases.set(binding, database);
  }

  return database;
}
