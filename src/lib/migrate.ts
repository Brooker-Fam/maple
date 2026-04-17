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

  // RSVP enhancements: public display opt-in, edit tracking, email lookup
  await sql`ALTER TABLE rsvps ADD COLUMN IF NOT EXISTS public_display BOOLEAN DEFAULT false`;
  await sql`ALTER TABLE rsvps ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`;
  await sql`CREATE INDEX IF NOT EXISTS idx_rsvps_email ON rsvps(email)`;

  // Phone number for SMS (E.164 format)
  await sql`ALTER TABLE rsvps ADD COLUMN IF NOT EXISTS phone VARCHAR(20)`;
  await sql`ALTER TABLE rsvps ADD COLUMN IF NOT EXISTS mailing_address TEXT`;
  await sql`ALTER TABLE rsvps ADD COLUMN IF NOT EXISTS attendee_names TEXT`;

  // Split guest count into adults and children
  await sql`ALTER TABLE rsvps ADD COLUMN IF NOT EXISTS adult_count INTEGER DEFAULT 1`;
  await sql`ALTER TABLE rsvps ADD COLUMN IF NOT EXISTS child_count INTEGER DEFAULT 0`;

  // Song requests and voting
  await sql`
    CREATE TABLE IF NOT EXISTS song_requests (
      id SERIAL PRIMARY KEY,
      requester_name VARCHAR(255) NOT NULL,
      song_title VARCHAR(500) NOT NULL,
      artist VARCHAR(500) NOT NULL,
      album_art_url TEXT,
      preview_url TEXT,
      itunes_url TEXT,
      itunes_track_id BIGINT UNIQUE,
      songlink_url TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS song_votes (
      id SERIAL PRIMARY KEY,
      song_request_id INTEGER NOT NULL REFERENCES song_requests(id) ON DELETE CASCADE,
      voter_name VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(song_request_id, voter_name)
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_song_requests_track_id ON song_requests(itunes_track_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_song_votes_song_id ON song_votes(song_request_id)`;

  // Cache Spotify URIs to avoid re-searching
  await sql`ALTER TABLE song_requests ADD COLUMN IF NOT EXISTS spotify_uri TEXT`;

  // Admin: pin songs to top of playlist, custom ordering
  await sql`ALTER TABLE song_requests ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT false`;
  await sql`ALTER TABLE song_requests ADD COLUMN IF NOT EXISTS sort_position INTEGER`;

  // Spotify integration config (encrypted tokens)
  await sql`
    CREATE TABLE IF NOT EXISTS spotify_config (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;

  // ========================================
  // FAMILY CALENDAR TABLES
  // ========================================

  await sql`
    CREATE TABLE IF NOT EXISTS households (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS family_members (
      id SERIAL PRIMARY KEY,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'adult',
      color VARCHAR(7) NOT NULL,
      avatar_emoji VARCHAR(10),
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_family_members_household ON family_members(household_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      title VARCHAR(500) NOT NULL,
      description TEXT,
      assigned_to INTEGER REFERENCES family_members(id) ON DELETE SET NULL,
      source VARCHAR(50) NOT NULL DEFAULT 'manual',
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      priority VARCHAR(10) NOT NULL DEFAULT 'medium',
      points INTEGER NOT NULL DEFAULT 0,
      due_date DATE,
      due_time TIME,
      duration_minutes INTEGER,
      recurrence_rule TEXT,
      google_event_id VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_tasks_household_due ON tasks(household_id, due_date)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_google_event ON tasks(google_event_id) WHERE google_event_id IS NOT NULL`;

  await sql`
    CREATE TABLE IF NOT EXISTS task_completions (
      id SERIAL PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      completed_by INTEGER NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
      completed_date DATE NOT NULL,
      points_earned INTEGER NOT NULL DEFAULT 0,
      photo_url TEXT,
      notes TEXT,
      verified_by INTEGER REFERENCES family_members(id) ON DELETE SET NULL,
      verified_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_completions_task ON task_completions(task_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_completions_date ON task_completions(completed_date)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_completions_task_date ON task_completions(task_id, completed_date)`;

  // ========================================
  // GOOGLE CALENDAR INTEGRATION
  // ========================================

  // Key-value store for OAuth tokens (mirrors spotify_config pattern).
  await sql`
    CREATE TABLE IF NOT EXISTS google_config (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;

  // Calendars available on the connected Google account. One row per calendar.
  await sql`
    CREATE TABLE IF NOT EXISTS google_calendars (
      id SERIAL PRIMARY KEY,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      google_calendar_id VARCHAR(500) NOT NULL,
      summary VARCHAR(500) NOT NULL,
      color VARCHAR(7),
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      assigned_to INTEGER REFERENCES family_members(id) ON DELETE SET NULL,
      sync_token TEXT,
      last_synced_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (household_id, google_calendar_id)
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_google_calendars_household ON google_calendars(household_id)`;

  // Events mirrored from Google. One row per expanded instance (singleEvents=true).
  await sql`
    CREATE TABLE IF NOT EXISTS calendar_events (
      id SERIAL PRIMARY KEY,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      google_calendar_id VARCHAR(500) NOT NULL,
      google_event_id VARCHAR(500) NOT NULL,
      ical_uid VARCHAR(500),
      etag VARCHAR(255),
      title VARCHAR(500) NOT NULL,
      description TEXT,
      location TEXT,
      start_at TIMESTAMPTZ NOT NULL,
      end_at TIMESTAMPTZ NOT NULL,
      all_day BOOLEAN NOT NULL DEFAULT FALSE,
      timezone VARCHAR(64),
      recurrence_rule TEXT,
      recurring_event_id VARCHAR(500),
      original_start_at TIMESTAMPTZ,
      assigned_to INTEGER REFERENCES family_members(id) ON DELETE SET NULL,
      color_override VARCHAR(7),
      points INTEGER NOT NULL DEFAULT 0,
      auto_award BOOLEAN NOT NULL DEFAULT FALSE,
      status VARCHAR(20) NOT NULL DEFAULT 'confirmed',
      html_link TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (google_calendar_id, google_event_id)
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_calendar_events_household_start ON calendar_events(household_id, start_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_calendar_events_assigned ON calendar_events(assigned_to)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_calendar_events_status ON calendar_events(status)`;

  // Event attendance — parallel to task_completions, feeds the same scoreboard.
  await sql`
    CREATE TABLE IF NOT EXISTS event_completions (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
      completed_by INTEGER NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
      completed_date DATE NOT NULL,
      points_earned INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (event_id, completed_by)
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_event_completions_event ON event_completions(event_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_event_completions_member_date ON event_completions(completed_by, completed_date)`;

  console.log("Migrations complete.");
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
