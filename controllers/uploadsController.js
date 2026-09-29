function toPublicId(item) {
  if (!item) return null;
  const s = String(item).trim();
  if (!s.includes('/upload/')) return s;
  const afterUpload = s.split('/upload/').pop().replace(/^v\d+\//, '');
  const lastDot = afterUpload.lastIndexOf('.');
  return lastDot > -1 ? afterUpload.slice(0, lastDot) : afterUpload;
}

async function deleteImages(req, res) {
  let cloudinary;
  try {
    cloudinary = require('cloudinary').v2;
  } catch (e) {
    return res.status(500).json({ error: 'Delete not available: missing dependency (cloudinary)' });
  }
  cloudinary.config();

  let inputs = [];
  if (req.body && Array.isArray(req.body.filenames)) inputs = inputs.concat(req.body.filenames);
  if (req.body && Array.isArray(req.body.urls)) inputs = inputs.concat(req.body.urls);
  if (req.body && Array.isArray(req.body.public_ids)) inputs = inputs.concat(req.body.public_ids);
  if (req.body && typeof req.body.filename === 'string') inputs.push(req.body.filename);
  if (req.body && typeof req.body.url === 'string') inputs.push(req.body.url);
  if (typeof req.query.filenames === 'string') inputs = inputs.concat(req.query.filenames.split(','));
  if (typeof req.query.filename === 'string') inputs.push(req.query.filename);
  if (typeof req.query.urls === 'string') inputs = inputs.concat(req.query.urls.split(','));
  if (typeof req.query.url === 'string') inputs.push(req.query.url);
  if (typeof req.query.public_ids === 'string') inputs = inputs.concat(req.query.public_ids.split(','));

  const set = new Set(inputs.map(toPublicId).filter(Boolean));
  if (set.size === 0) {
    return res.status(400).json({ error: 'Provide filename(s), url(s), or public_id(s) to delete.' });
  }

  const publicIds = Array.from(set);
  const results = [];
  const deleted = [];
  const not_found = [];
  const errors = [];

  const db = req.app.locals.db;
  for (const publicId of publicIds) {
    try {
      const result = await cloudinary.uploader.destroy(publicId);
      if (result.result !== 'ok') {
        not_found.push(publicId);
        results.push({ public_id: publicId, status: 'not_found' });
        continue;
      }
      deleted.push(publicId);
      results.push({ public_id: publicId, status: 'deleted' });

      const likePattern = `%${publicId}%`;
      try { await db.runAsync('DELETE FROM property_pictures WHERE url LIKE ?', [likePattern]); } catch (_) {}
      try { await db.runAsync('UPDATE properties SET cover = NULL WHERE cover LIKE ?', [likePattern]); } catch (_) {}
      try { await db.runAsync('UPDATE users SET picture = NULL WHERE picture LIKE ?', [likePattern]); } catch (_) {}
    } catch (e) {
      errors.push({ public_id: publicId, error: e.message });
      results.push({ public_id: publicId, status: 'error', error: e.message });
    }
  }

  const status = errors.length === 0 ? 200 : (deleted.length > 0 ? 207 : 400);
  return res.status(status).json({ ok: errors.length === 0, deleted, not_found, errors, results });
}

module.exports = { deleteImages };