import { PrismaClient } from "./generated/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import dotenv from "dotenv";

// 1. Ensure environment variables are loaded before anything else
dotenv.config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error("❌ DATABASE_URL is not defined in your .env file");
}

// 2. Configure the connection pool
const pool = new pg.Pool({ 
  connectionString,
  // If you are using a cloud DB like Neon/Render, 
  // they usually require SSL. This line handles it safely:
  ssl: connectionString?.includes("localhost") || connectionString?.includes("127.0.0.1") 
    ? false 
    : { rejectUnauthorized: false }
});

// 3. Optional: Connection Debugger
// This will tell you immediately in the terminal if your DB URL is working
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('🔴 Postgres Connection Error:', err.message);
  } else {
    console.log('🟢 Postgres Connected Successfully at:', res.rows[0].now);
  }
});

const adapter = new PrismaPg(pool);

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// 4. Initialize Prisma Client
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: adapter,
    log: ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}