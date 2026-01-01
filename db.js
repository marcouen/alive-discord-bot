const { Pool } = require("pg");
const fs = require("fs");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("Missing DATABASE_URL env var");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDb() {
  const schema = fs.readFileSync("./schema.sql", "utf8");
  await pool.query(schema);
}

async function q(text, params) {
  return pool.query(text, params);
}

module.exports = { q, initDb };
