import { neon } from "@neondatabase/serverless";

export function getDb() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return null;
  }
  return neon(databaseUrl);
}

export async function query(sql: string, params: unknown[] = []) {
  const db = getDb();
  if (!db) {
    return null;
  }
  return db.query(sql, params);
}
