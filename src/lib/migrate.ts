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

  // Mailing lists for printing address labels (bridal shower, thank-yous, etc.)
  await sql`
    CREATE TABLE IF NOT EXISTS mailing_lists (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS mailing_list_entries (
      id SERIAL PRIMARY KEY,
      list_id INTEGER NOT NULL REFERENCES mailing_lists(id) ON DELETE CASCADE,
      rsvp_id INTEGER NOT NULL REFERENCES rsvps(id) ON DELETE CASCADE,
      addressee TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (list_id, rsvp_id)
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_mailing_list_entries_list ON mailing_list_entries(list_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_mailing_list_entries_rsvp ON mailing_list_entries(rsvp_id)`;

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

  // ========================================
  // SAPPHIRE'S BIRTHDAY RSVP
  // Standalone party RSVP (separate from wedding rsvps table)
  // ========================================

  await sql`
    CREATE TABLE IF NOT EXISTS birthday_rsvps (
      id SERIAL PRIMARY KEY,
      parent_name VARCHAR(255) NOT NULL,
      child_names VARCHAR(500),
      email VARCHAR(255),
      phone VARCHAR(20),
      attending BOOLEAN DEFAULT true,
      kid_count INTEGER DEFAULT 1,
      adult_count INTEGER DEFAULT 1,
      allergies TEXT,
      birthday_wish TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_birthday_rsvps_email ON birthday_rsvps(email)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_birthday_rsvps_phone ON birthday_rsvps(phone)`;

  // child_names now holds one kid name per line (broken-out kid rows). Widen and
  // backfill legacy free-text ("Lily & Max", "Eli and Ronen") into newline-delimited form.
  await sql`ALTER TABLE birthday_rsvps ALTER COLUMN child_names TYPE TEXT`;
  await sql`
    UPDATE birthday_rsvps
    SET child_names = regexp_replace(child_names, '\\s*&\\s*|\\s*,\\s*|\\s+and\\s+', chr(10), 'gi')
    WHERE child_names IS NOT NULL
      AND position(chr(10) in child_names) = 0
      AND child_names ~* '&|,|\\sand\\s'
  `;

  // ========================================
  // SEATING CHART
  // Single-document store for the reception seating planner.
  // The whole chart (tables, groups, per-guest assignments) is saved as one
  // JSON blob keyed by 'chart', mirroring the spotify_config / google_config
  // key-value pattern. Guests are derived live from the rsvps table, so the
  // assignments only reference guest keys -- no per-guest rows to keep in sync.
  // ========================================

  await sql`
    CREATE TABLE IF NOT EXISTS seating_config (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;

  // ========================================
  // GUEST PHOTO GALLERY
  // Photos/videos guests upload at the party. Files live in Vercel Blob;
  // this table only stores the public URL + metadata. Newest-first display.
  // ========================================

  await sql`
    CREATE TABLE IF NOT EXISTS photos (
      id SERIAL PRIMARY KEY,
      url TEXT NOT NULL,
      content_type VARCHAR(100),
      media_type VARCHAR(10) NOT NULL DEFAULT 'image',
      uploader_name VARCHAR(255),
      width INTEGER,
      height INTEGER,
      size_bytes BIGINT,
      approved BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_photos_created ON photos(created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_photos_approved ON photos(approved, created_at DESC)`;

  // Per-upload secret. Returned to the uploader once (POST response) and stored
  // in their browser, so a guest can delete their own photo without an account.
  // Never selected by the public GET, so other guests can't see it.
  await sql`ALTER TABLE photos ADD COLUMN IF NOT EXISTS delete_token VARCHAR(64)`;

  // Small (~512px) grid thumbnail uploaded alongside the full image, so the
  // gallery grid doesn't pull full-resolution JPEGs for every tile. Null for
  // videos (grid uses a video poster) and for images we couldn't re-encode.
  await sql`ALTER TABLE photos ADD COLUMN IF NOT EXISTS thumb_url TEXT`;

  // Fixed-hourly-window counter keyed by hashed IP — caps how many upload tokens
  // one source can mint, so a stranger who finds the URL can't burn Blob storage.
  await sql`
    CREATE TABLE IF NOT EXISTS upload_rate_limit (
      ip_hash VARCHAR(64) NOT NULL,
      window_start TIMESTAMP NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (ip_hash, window_start)
    )
  `;

  console.log("Migrations complete.");
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
