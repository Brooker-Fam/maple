import { neon } from "@neondatabase/serverless";

async function migrate() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.log("No DATABASE_URL set, skipping migration.");
    return;
  }

  const sql = neon(databaseUrl);
  console.log("Running database migrations...");

  await sql`
    CREATE TABLE IF NOT EXISTS rsvps (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      guest_count INTEGER DEFAULT 1,
      attending BOOLEAN DEFAULT true,
      dietary_restrictions TEXT,
      potluck_dish TEXT,
      message TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS game_scores (
      id SERIAL PRIMARY KEY,
      player_name VARCHAR(100) NOT NULL,
      game_id VARCHAR(50) NOT NULL,
      score INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_game_scores_game_id ON game_scores(game_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_game_scores_score ON game_scores(game_id, score DESC)`;

  console.log("Migrations complete.");
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
