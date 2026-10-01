const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'kasa.sqlite3');
const PROPS_JSON_PATH = path.join(__dirname, 'data', 'properties.json');

function openDb() {
  // TURSO_DATABASE_URL in production; falls back to a local file for dev, so behavior is unchanged locally
  const url = process.env.TURSO_DATABASE_URL || `file:${DB_PATH}`;
  if (!process.env.TURSO_DATABASE_URL) fs.mkdirSync(DATA_DIR, { recursive: true });

  const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

  return {
    async runAsync(sql, params = []) {
      const result = await client.execute({ sql, args: params });
      return { lastID: Number(result.lastInsertRowid || 0), changes: result.rowsAffected };
    },
    async getAsync(sql, params = []) {
      const result = await client.execute({ sql, args: params });
      return result.rows[0];
    },
    async allAsync(sql, params = []) {
      const result = await client.execute({ sql, args: params });
      return result.rows;
    },
    async execAsync(sql) {
      await client.executeMultiple(sql);
    },
  };
}

async function initSchema(db) {
  const schema = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    picture TEXT,
    role TEXT NOT NULL CHECK (role IN ('owner','client','admin')),
    email TEXT,
    password_hash TEXT,
    UNIQUE(name, picture),
    UNIQUE(email)
  );

  CREATE TABLE IF NOT EXISTS properties (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    cover TEXT,
    location TEXT,
    host_id INTEGER NOT NULL,
    rating_avg REAL DEFAULT 0,
    ratings_count INTEGER DEFAULT 0,
    price_per_night INTEGER NOT NULL,
    FOREIGN KEY(host_id) REFERENCES users(id) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS property_pictures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    property_id TEXT NOT NULL,
    url TEXT NOT NULL,
    UNIQUE(property_id, url),
    FOREIGN KEY(property_id) REFERENCES properties(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS property_equipments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    property_id TEXT NOT NULL,
    name TEXT NOT NULL,
    UNIQUE(property_id, name),
    FOREIGN KEY(property_id) REFERENCES properties(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS property_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    property_id TEXT NOT NULL,
    name TEXT NOT NULL,
    UNIQUE(property_id, name),
    FOREIGN KEY(property_id) REFERENCES properties(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    property_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
    comment TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(property_id) REFERENCES properties(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS favorites (
    user_id INTEGER NOT NULL,
    property_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, property_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(property_id) REFERENCES properties(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    property_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(property_id) REFERENCES properties(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS conversation_participants (
    conversation_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    last_read_at DATETIME,
    PRIMARY KEY (conversation_id, user_id),
    FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    body TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY(sender_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_conversation_participants_user ON conversation_participants(user_id);
  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_properties_host ON properties(host_id);
  CREATE INDEX IF NOT EXISTS idx_ratings_property ON ratings(property_id);
  CREATE INDEX IF NOT EXISTS idx_ratings_user ON ratings(user_id);
  `;

  await db.execAsync(schema);

  // Ensure auth columns exist for old DBs created before email/password/reset fields
  try {
    const cols = await db.allAsync("PRAGMA table_info('users')");
    const names = new Set(cols.map(c => c.name));
    if (!names.has('email')) {
      await db.runAsync('ALTER TABLE users ADD COLUMN email TEXT');
      await db.runAsync('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)');
    }
    if (!names.has('password_hash')) {
      await db.runAsync('ALTER TABLE users ADD COLUMN password_hash TEXT');
    }
    if (!names.has('reset_token')) {
      await db.runAsync('ALTER TABLE users ADD COLUMN reset_token TEXT');
      await db.runAsync('CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users(reset_token)');
    }
    if (!names.has('reset_expires')) {
      await db.runAsync('ALTER TABLE users ADD COLUMN reset_expires INTEGER');
    }
  } catch (e) {
    // ignore
  }

  // Ensure slug column exists and is populated for properties
  try {
    const pcols = await db.allAsync("PRAGMA table_info('properties')");
    const pnames = new Set(pcols.map(c => c.name));
    if (!pnames.has('slug')) {
      await db.runAsync('ALTER TABLE properties ADD COLUMN slug TEXT');
      // Backfill slugs from titles
      const rows = await db.allAsync('SELECT id, title FROM properties');
      const used = new Set();
      for (const row of rows) {
        const base = slugify(row.title || row.id || 'property');
        let slug = base;
        let n = 2;
        while (used.has(slug)) {
          slug = `${base}-${n++}`;
        }
        used.add(slug);
        await db.runAsync('UPDATE properties SET slug = ? WHERE id = ?', [slug, row.id]);
      }
      await db.runAsync('CREATE UNIQUE INDEX IF NOT EXISTS idx_properties_slug ON properties(slug)');
    }
  } catch (e) {
    // ignore
  }
}

function deterministicPrice(idOrTitle) {
  const s = String(idOrTitle);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return 45 + (h % 256);
}

function slugify(input) {
  const s = String(input || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const slug = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
  return slug || 'property';
}

async function seedIfEmpty(db) {
  const row = await db.getAsync('SELECT COUNT(*) as c FROM properties');
  if (row && row.c > 0) return;

  if (!fs.existsSync(PROPS_JSON_PATH)) return;
  const raw = fs.readFileSync(PROPS_JSON_PATH, 'utf-8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error('Failed to parse properties.json:', e.message);
    return;
  }

  const usedSlugs = new Set();
  for (const p of data) {
    const hostName = p.host && p.host.name ? p.host.name : 'Unknown';
    const hostPic = p.host && p.host.picture ? p.host.picture : null;

    let user = await db.getAsync("SELECT id FROM users WHERE name = ? AND IFNULL(picture, '') = IFNULL(?, '')", [hostName, hostPic]);
    if (!user) {
      const ins = await db.runAsync('INSERT INTO users(name, picture, role) VALUES (?,?,?)', [hostName, hostPic, 'owner']);
      user = { id: ins.lastID };
    }

    const base = slugify(p.title || p.id || hostName);
    let slug = base;
    let n = 2;
    while (usedSlugs.has(slug)) {
      slug = `${base}-${n++}`;
    }
    usedSlugs.add(slug);

    const price = deterministicPrice(p.id || p.title || hostName);
    const ratingAvg = p.rating ? Number(p.rating) : 0;
    await db.runAsync(
      'INSERT OR IGNORE INTO properties(id, title, slug, description, cover, location, host_id, rating_avg, price_per_night) VALUES (?,?,?,?,?,?,?,?,?)',
      [p.id, p.title, slug, p.description || null, p.cover || null, p.location || null, user.id, ratingAvg, price]
    );

    const pics = new Set();
    if (p.cover) pics.add(p.cover);
    if (Array.isArray(p.pictures)) p.pictures.forEach(u => u && pics.add(u));
    for (const url of pics) {
      await db.runAsync('INSERT OR IGNORE INTO property_pictures(property_id, url) VALUES (?,?)', [p.id, url]);
    }

    if (Array.isArray(p.equipments)) {
      for (const name of p.equipments) {
        await db.runAsync('INSERT OR IGNORE INTO property_equipments(property_id, name) VALUES (?,?)', [p.id, name]);
      }
    }
    if (Array.isArray(p.tags)) {
      for (const name of p.tags) {
        await db.runAsync('INSERT OR IGNORE INTO property_tags(property_id, name) VALUES (?,?)', [p.id, name]);
      }
    }
  }
}

async function initialize() {
  const db = openDb();
  await initSchema(db);
  await seedIfEmpty(db);
  return db;
}

module.exports = { initialize, openDb, DB_PATH, slugify };