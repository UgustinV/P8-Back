function mapPropertyRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    cover: row.cover,
    location: row.location,
    price_per_night: row.price_per_night,
    rating_avg: row.rating_avg,
    ratings_count: row.ratings_count,
    host: row.host_id ? { id: row.host_id, name: row.host_name, picture: row.host_picture } : undefined,
  };
}

function genId() {
  return Math.random().toString(16).slice(2, 10);
}

function slugify(input) {
  const s = String(input || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const slug = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
  return slug || 'property';
}

async function ensureUniqueSlug(db, base, excludeId = null) {
  let slug = base;
  let n = 2;
  // Loop until slug is unique
  while (true) {
    const row = excludeId
      ? await db.getAsync('SELECT id FROM properties WHERE slug = ? AND id != ?', [slug, excludeId])
      : await db.getAsync('SELECT id FROM properties WHERE slug = ?', [slug]);
    if (!row) return slug;
    slug = `${base}-${n++}`;
  }
}

async function listProperties(db) {
  const rows = await db.allAsync(`
      SELECT p.*, u.name AS host_name, u.picture AS host_picture
      FROM properties p
      JOIN users u ON u.id = p.host_id
      ORDER BY p.title ASC
    `);
  return rows.map(mapPropertyRow);
}

async function getPropertyDetails(db, id) {
  const row = await db.getAsync(`
    SELECT p.*, u.name AS host_name, u.picture AS host_picture
    FROM properties p
    JOIN users u ON u.id = p.host_id
    WHERE p.id = ?
  `, [id]);
  if (!row) return null;
  const base = mapPropertyRow(row);
  const pictures = await db.allAsync('SELECT url FROM property_pictures WHERE property_id = ?', [id]);
  const equipments = await db.allAsync('SELECT name FROM property_equipments WHERE property_id = ?', [id]);
  const tags = await db.allAsync('SELECT name FROM property_tags WHERE property_id = ?', [id]);
  return {
    ...base,
    pictures: pictures.map(r => r.url),
    equipments: equipments.map(r => r.name),
    tags: tags.map(r => r.name),
  };
}

async function ensureHost(db, host_id, host) {
  if (host_id) return host_id;
  if (host && host.name) {
    const hostName = String(host.name);
    const hostPic = host.picture || null;
    const found = await db.getAsync("SELECT id FROM users WHERE name = ? AND IFNULL(picture, '') = IFNULL(?, '')", [hostName, hostPic]);
    if (found) return found.id;
    const ins = await db.runAsync('INSERT INTO users(name, picture, role) VALUES (?,?,?)', [hostName, hostPic, 'owner']);
    return ins.lastID;
  }
  return null;
}

async function createProperty(db, payload) {
  const {
    id,
    title,
    description = null,
    cover = null,
    location = null,
    price_per_night,
    host_id,
    host,
    pictures = [],
    equipments = [],
    tags = [],
  } = payload || {};

  if (!title) throw new Error('title is required');
  let price = Number(price_per_night);
  if (!Number.isFinite(price) || price <= 0) price = 80;

  const resolvedHostId = await ensureHost(db, host_id, host);
  if (!resolvedHostId) {
    const err = new Error('host_id or host{name,picture} is required');
    err.status = 400; // to allow controller to map specific status
    throw err;
  }

  const newId = id || genId();
  const base = slugify(title);
  const uniqueSlug = await ensureUniqueSlug(db, base);
  await db.runAsync(
    'INSERT INTO properties(id, title, slug, description, cover, location, host_id, price_per_night) VALUES (?,?,?,?,?,?,?,?)',
    [newId, title, uniqueSlug, description, cover, location, resolvedHostId, price]
  );

  if (Array.isArray(pictures)) {
    for (const url of pictures) {
      if (url) await db.runAsync('INSERT OR IGNORE INTO property_pictures(property_id, url) VALUES (?,?)', [newId, url]);
    }
  }
  if (Array.isArray(equipments)) {
    for (const name of equipments) {
      if (name) await db.runAsync('INSERT OR IGNORE INTO property_equipments(property_id, name) VALUES (?,?)', [newId, name]);
    }
  }
  if (Array.isArray(tags)) {
    for (const name of tags) {
      if (name) await db.runAsync('INSERT OR IGNORE INTO property_tags(property_id, name) VALUES (?,?)', [newId, name]);
    }
  }

  return await getPropertyDetails(db, newId);
}

async function updateProperty(db, id, changes) {
  const allowed = ['title', 'description', 'cover', 'location', 'host_id', 'price_per_night'];
  const fields = [];
  const params = [];

  let newSlug = null;
  if (Object.prototype.hasOwnProperty.call(changes || {}, 'title')) {
    const base = slugify(changes.title);
    newSlug = await ensureUniqueSlug(db, base, id);
  }

  for (const k of allowed) {
    if (k in (changes || {})) {
      fields.push(`${k} = ?`);
      params.push(changes[k]);
    }
  }
  if (newSlug) {
    fields.push('slug = ?');
    params.push(newSlug);
  }

  if (fields.length === 0) {
    const err = new Error('No fields to update');
    err.status = 400;
    throw err;
  }
  params.push(id);
  const r = await db.runAsync(`UPDATE properties SET ${fields.join(', ')} WHERE id = ?`, params);
  if (r.changes === 0) {
    const err = new Error('Property not found');
    err.status = 404;
    throw err;
  }
  return await getPropertyDetails(db, id);
}

async function deleteProperty(db, id) {
  const r = await db.runAsync('DELETE FROM properties WHERE id = ?', [id]);
  if (r.changes === 0) {
    const err = new Error('Property not found');
    err.status = 404;
    throw err;
  }
}

async function getPropertyOwnerId(db, id) {
  const row = await db.getAsync('SELECT host_id FROM properties WHERE id = ?', [id]);
  return row ? row.host_id : null;
}

module.exports = {
  listProperties,
  getPropertyDetails,
  createProperty,
  updateProperty,
  deleteProperty,
  getPropertyOwnerId,
};
