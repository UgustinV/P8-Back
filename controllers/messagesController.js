const {
  createConversation,
  getConversationForUser,
  listConversationsForUser,
  listMessages,
  sendMessage,
  markRead,
} = require('../services/messagesService');

function statusFromError(e) {
  if (e && e.status) return e.status;
  return 500;
}

async function create(req, res) {
  const db = req.app.locals.db;
  try {
    const result = await createConversation(db, req.user && req.user.id, req.body || {});
    res.status(201).json(result);
  } catch (e) {
    res.status(statusFromError(e)).json({ error: e.message });
  }
}

async function listMine(req, res) {
  const db = req.app.locals.db;
  try {
    const result = await listConversationsForUser(db, req.user && req.user.id);
    res.json(result);
  } catch (e) {
    res.status(statusFromError(e)).json({ error: e.message });
  }
}

async function getById(req, res) {
  const db = req.app.locals.db;
  try {
    const result = await getConversationForUser(db, req.params.id, req.user && req.user.id);
    res.json(result);
  } catch (e) {
    res.status(statusFromError(e)).json({ error: e.message });
  }
}

async function listConversationMessages(req, res) {
  const db = req.app.locals.db;
  try {
    const result = await listMessages(db, req.params.id, req.user && req.user.id, req.query || {});
    res.json(result);
  } catch (e) {
    res.status(statusFromError(e)).json({ error: e.message });
  }
}

async function sendConversationMessage(req, res) {
  const db = req.app.locals.db;
  try {
    const result = await sendMessage(db, req.params.id, req.user && req.user.id, req.body && req.body.body);
    res.status(201).json(result);
  } catch (e) {
    res.status(statusFromError(e)).json({ error: e.message });
  }
}

async function markConversationRead(req, res) {
  const db = req.app.locals.db;
  try {
    const result = await markRead(db, req.params.id, req.user && req.user.id);
    res.json(result);
  } catch (e) {
    res.status(statusFromError(e)).json({ error: e.message });
  }
}

module.exports = {
  create,
  listMine,
  getById,
  listConversationMessages,
  sendConversationMessage,
  markConversationRead,
};