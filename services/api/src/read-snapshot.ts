import type { DatabaseSync } from "node:sqlite";

// Keep aggregate rows and their indexer cursor on the same SQLite snapshot.
export function withReadSnapshot<T>(db: DatabaseSync, read: () => T): T {
  db.exec("BEGIN DEFERRED");
  try {
    return read();
  } finally {
    db.exec("ROLLBACK");
  }
}
