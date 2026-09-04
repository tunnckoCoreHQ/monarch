/// <reference types="@cloudflare/workers-types" />

function unsupportedQuery(): never {
  throw new Error("The schema database supports Better Auth SQL generation only");
}

function unsupportedIntrospection(): never {
  throw new Error("no such table: oauthResource");
}

const schemaIntrospectionQuery =
  'select "name", "type", "sql" from "sqlite_master" where "type" in (?, ?) and "name" not like ? and "name" not like ? and "name" != ? and "name" != ?';
const schemaIntrospectionParameters = [
  "table",
  "view",
  "sqlite_%",
  "_cf_%",
  "kysely_migration",
  "kysely_migration_lock",
];
const indexIntrospectionQuery = `
  SELECT
    tables.name AS "tableName",
    index_list.name AS "indexName",
    index_info.name AS "columnName",
    index_list."unique" AS "isUnique",
    index_list.partial AS "isPartial",
    index_info.seqno AS "columnPosition"
  FROM sqlite_master AS tables
  INNER JOIN pragma_index_list(tables.name) AS index_list
  INNER JOIN pragma_index_info(index_list.name) AS index_info
  WHERE tables.type = 'table'
`;

function normalizedQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

const emptySchemaResult = {
  success: true,
  results: [],
  meta: {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: 0,
    last_row_id: 0,
    changed_db: false,
    changes: 0,
  },
};

function createSchemaIntrospectionStatement(
  expectedParameters: readonly unknown[],
): D1PreparedStatement {
  let boundParameters: unknown[] = [];
  const statement = {
    bind: (...values: unknown[]) => {
      boundParameters = values;

      return statement;
    },
    all: async () => {
      const hasExactParameters =
        boundParameters.length === expectedParameters.length &&
        boundParameters.every((value, index) => value === expectedParameters[index]);
      if (!hasExactParameters) {
        return unsupportedIntrospection();
      }

      return emptySchemaResult;
    },
    first: unsupportedQuery,
    raw: unsupportedQuery,
    run: unsupportedQuery,
  } as unknown as D1PreparedStatement;

  return statement;
}

export const authSchemaDatabase = {
  prepare: (query: string) => {
    if (query === schemaIntrospectionQuery) {
      return createSchemaIntrospectionStatement(schemaIntrospectionParameters);
    }
    if (normalizedQuery(query) === normalizedQuery(indexIntrospectionQuery)) {
      return createSchemaIntrospectionStatement([]);
    }

    return unsupportedIntrospection();
  },
  batch: unsupportedQuery,
  exec: unsupportedQuery,
} as unknown as D1Database;
