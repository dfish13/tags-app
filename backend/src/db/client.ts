import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const client = postgres(connectionString);
export const db = drizzle(client, { schema });

// Release the connection pool. The server never calls this — it holds its
// connections for the life of the process — but anything short-lived must, or
// it will hang on exit: postgres.js keeps its sockets open and idle sockets
// keep Node's event loop alive. That's what wedged the test runner.
export function closeDb() {
  return client.end({ timeout: 5 });
}
