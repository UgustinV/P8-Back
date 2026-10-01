const express = require('express');
const router = express.Router();

const dbReady = require('../middlewares/dbReady');
const { requireRole, requireAdmin, requireSelfOrAdmin, requireAuth } = require('../middlewares/auth');
const properties = require('../controllers/propertiesController');
const users = require('../controllers/usersController');
const ratings = require('../controllers/ratingsController');
const favorites = require('../controllers/favoritesController');
const uploads = require('../controllers/uploadsController');
const messages = require('../controllers/messagesController');

// Ensure DB is ready for all API routes
router.use(dbReady);

// Properties
router.get('/properties', properties.list);
router.get('/properties/:id', properties.getById);
router.post('/properties', requireRole(['owner','admin']), properties.create);
router.patch('/properties/:id', requireRole(['owner','admin']), properties.update);
router.delete('/properties/:id', requireRole(['owner','admin']), properties.remove);

// Users
router.get('/users', requireAdmin, users.list);
router.get('/users/:id', requireSelfOrAdmin('id'), users.getById);
router.post('/users', requireAdmin, users.create);
router.patch('/users/:id', requireSelfOrAdmin('id'), users.update);

// Ratings for properties
router.get('/properties/:id/ratings', ratings.listForProperty);
router.post('/properties/:id/ratings', ratings.add);

// Favorites
router.post('/properties/:id/favorite', requireAuth, favorites.addForProperty);
router.delete('/properties/:id/favorite', requireAuth, favorites.removeForProperty);
router.get('/users/:id/favorites', requireSelfOrAdmin('id'), favorites.listForUser);


// Delete one or multiple uploaded images by filename or URL
router.delete('/uploads/images', requireRole(['owner','admin']), uploads.deleteImages);

// Messages
router.post('/conversations', requireAuth, messages.create);
router.get('/conversations', requireAuth, messages.listMine);
router.get('/conversations/:id', requireAuth, messages.getById);
router.get('/conversations/:id/messages', requireAuth, messages.listConversationMessages);
router.post('/conversations/:id/messages', requireAuth, messages.sendConversationMessage);
router.post('/conversations/:id/read', requireAuth, messages.markConversationRead);

module.exports = router;
