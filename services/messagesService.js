async function ensureUserExists(db, userId) {
  const user = await db.getAsync('SELECT id FROM users WHERE id = ?', [userId]);
  if (!user) { const err = new Error('User not found'); err.status = 404; throw err; }
  return user;
}

async function assertParticipant(db, conversationId, userId) {
  const row = await db.getAsync(
    'SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?',
    [conversationId, userId]
  );
  // 404 instead of 403 to avoid revealing conversation existence to non-participants
  if (!row) { const err = new Error('Conversation not found'); err.status = 404; throw err; }
}

async function findExistingConversation(db, userId, recipientId, propertyId) {
  const row = await db.getAsync(`
    SELECT c.id FROM conversations c
    WHERE IFNULL(c.property_id, '') = IFNULL(?, '')
      AND c.id IN (SELECT conversation_id FROM conversation_participants WHERE user_id = ?)
      AND c.id IN (SELECT conversation_id FROM conversation_participants WHERE user_id = ?)
      AND (SELECT COUNT(*) FROM conversation_participants WHERE conversation_id = c.id) = 2
    LIMIT 1
  `, [propertyId || null, userId, recipientId]);
  return row ? row.id : null;
}

async function createConversation(db, userId, { recipient_id, property_id = null, message } = {}) {
  if (!userId) { const err = new Error('authentication required'); err.status = 401; throw err; }
  const recipientId = Number(recipient_id);
  if (!recipientId) { const err = new Error('recipient_id is required'); err.status = 400; throw err; }
  if (recipientId === Number(userId)) { const err = new Error('cannot start a conversation with yourself'); err.status = 400; throw err; }

  await ensureUserExists(db, userId);
  await ensureUserExists(db, recipientId);

  if (property_id) {
    const prop = await db.getAsync('SELECT id FROM properties WHERE id = ?', [property_id]);
    if (!prop) { const err = new Error('Property not found'); err.status = 404; throw err; }
  }

  let conversationId = await findExistingConversation(db, userId, recipientId, property_id);
  if (!conversationId) {
    const ins = await db.runAsync('INSERT INTO conversations(property_id) VALUES (?)', [property_id || null]);
    conversationId = ins.lastID;
    await db.runAsync('INSERT INTO conversation_participants(conversation_id, user_id) VALUES (?,?)', [conversationId, userId]);
    await db.runAsync('INSERT INTO conversation_participants(conversation_id, user_id) VALUES (?,?)', [conversationId, recipientId]);
  }

  if (message && String(message).trim()) {
    await sendMessage(db, conversationId, userId, message);
  }

  return getConversationForUser(db, conversationId, userId);
}

async function getConversationForUser(db, conversationId, userId) {
  await assertParticipant(db, conversationId, userId);
  const conv = await db.getAsync('SELECT * FROM conversations WHERE id = ?', [conversationId]);
  const participants = await db.allAsync(`
    SELECT u.id, u.name, u.picture, u.role
    FROM conversation_participants cp
    JOIN users u ON u.id = cp.user_id
    WHERE cp.conversation_id = ?
  `, [conversationId]);
  return {
    id: conv.id,
    property_id: conv.property_id,
    created_at: conv.created_at,
    updated_at: conv.updated_at,
    participants,
  };
}

async function listConversationsForUser(db, userId) {
  await ensureUserExists(db, userId);
  const convRows = await db.allAsync(`
    SELECT c.id, c.property_id, c.created_at, c.updated_at, cp.last_read_at
    FROM conversations c
    JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.user_id = ?
    ORDER BY c.updated_at DESC
  `, [userId]);

  const result = [];
  for (const conv of convRows) {
    const participants = await db.allAsync(`
      SELECT u.id, u.name, u.picture
      FROM conversation_participants cp
      JOIN users u ON u.id = cp.user_id
      WHERE cp.conversation_id = ? AND cp.user_id != ?
    `, [conv.id, userId]);

    const lastMessage = await db.getAsync(
      'SELECT id, sender_id, body, created_at FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1',
      [conv.id]
    );

    const unread = await db.getAsync(
      `SELECT COUNT(*) as c FROM messages
       WHERE conversation_id = ? AND sender_id != ?
         AND (? IS NULL OR created_at > ?)`,
      [conv.id, userId, conv.last_read_at, conv.last_read_at]
    );

    result.push({
      id: conv.id,
      property_id: conv.property_id,
      created_at: conv.created_at,
      updated_at: conv.updated_at,
      participants,
      last_message: lastMessage || null,
      unread_count: unread ? unread.c : 0,
    });
  }
  return result;
}

async function listMessages(db, conversationId, userId, { limit = 50, before_id } = {}) {
  await assertParticipant(db, conversationId, userId);
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);

  const rows = before_id
    ? await db.allAsync(
        'SELECT * FROM messages WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
        [conversationId, before_id, lim]
      )
    : await db.allAsync(
        'SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?',
        [conversationId, lim]
      );

  // return oldest -> newest for easy rendering
  return rows.reverse().map(r => ({
    id: r.id,
    conversation_id: r.conversation_id,
    sender_id: r.sender_id,
    body: r.body,
    created_at: r.created_at,
  }));
}

async function sendMessage(db, conversationId, userId, body) {
  await assertParticipant(db, conversationId, userId);
  const text = String(body || '').trim();
  if (!text) { const err = new Error('message body is required'); err.status = 400; throw err; }

  const ins = await db.runAsync(
    'INSERT INTO messages(conversation_id, sender_id, body) VALUES (?,?,?)',
    [conversationId, userId, text]
  );
  await db.runAsync('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [conversationId]);
  // sending implies the sender has read up to now
  await db.runAsync(
    'UPDATE conversation_participants SET last_read_at = CURRENT_TIMESTAMP WHERE conversation_id = ? AND user_id = ?',
    [conversationId, userId]
  );

  const message = await db.getAsync('SELECT * FROM messages WHERE id = ?', [ins.lastID]);
  return {
    id: message.id,
    conversation_id: message.conversation_id,
    sender_id: message.sender_id,
    body: message.body,
    created_at: message.created_at,
  };
}

async function markRead(db, conversationId, userId) {
  await assertParticipant(db, conversationId, userId);
  await db.runAsync(
    'UPDATE conversation_participants SET last_read_at = CURRENT_TIMESTAMP WHERE conversation_id = ? AND user_id = ?',
    [conversationId, userId]
  );
  return { ok: true };
}

module.exports = {
  createConversation,
  getConversationForUser,
  listConversationsForUser,
  listMessages,
  sendMessage,
  markRead,
};