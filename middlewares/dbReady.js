module.exports = async function dbReady(req, res, next) {
  try {
    req.app.locals.db = await req.app.locals.dbPromise;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Database initialization failed: ' + err.message });
  }
};