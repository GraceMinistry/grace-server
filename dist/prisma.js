"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.prisma = void 0;
const prisma_1 = require("./generated/prisma");
// import { PrismaClient } from "@prisma/client";
const adapter_pg_1 = require("@prisma/adapter-pg");
const pg_1 = __importDefault(require("pg"));
const dotenv_1 = __importDefault(require("dotenv"));
// 1. Ensure environment variables are loaded before anything else
dotenv_1.default.config();
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
    console.error("❌ DATABASE_URL is not defined in your .env file");
}
// 2. Configure the connection pool
const pool = new pg_1.default.Pool({
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
    }
    else {
        console.log('🟢 Postgres Connected Successfully at:', res.rows[0].now);
    }
});
const adapter = new adapter_pg_1.PrismaPg(pool);
const globalForPrisma = globalThis;
// 4. Initialize Prisma Client
exports.prisma = globalForPrisma.prisma ??
    new prisma_1.PrismaClient({
        adapter: adapter,
        log: ["error"],
    });
if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = exports.prisma;
}
