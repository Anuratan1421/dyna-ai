const mongoose = require('mongoose');
const crypto = require('crypto');
require('./user'); // Make sure the User model is registered

// Helper: Encrypt message
const encryptMessage = (text, encryptionKey) => {
  if (!text) return text;
  const iv = crypto.randomBytes(16); // 16-byte IV
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(encryptionKey, 'hex'), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
};

// Helper: Decrypt message
const decryptMessage = (encryptedText, encryptionKey) => {
  if (!encryptedText) return encryptedText;
  const [ivHex, encrypted] = encryptedText.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(encryptionKey, 'hex'), iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
};

// GroupMessage Schema
const groupMessageSchema = new mongoose.Schema({
  groupId: {
    type: String,
    required: true,
  },
  senderId: {
    type: String,
    required: true,
  },
  senderName: {
    type: String,
    required: true,
  },
  content: {
    type: String,
    default: '',
  },
  imageUrl: {
    type: String,
    default: null,
  },
  musicData: {
    type: Object,
    default: null,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
});

// Pre-save hook: Encrypt content before saving
groupMessageSchema.pre('save', async function (next) {
  const message = this;

  if (!message.content && !message.imageUrl) {
    return next(new Error('Either content or imageUrl is required.'));
  }

  try {
    const sender = await mongoose.model('User').findById(message.senderId);
    if (!sender || !sender.encryptionKey) {
      return next(new Error('Sender or encryption key not found.'));
    }

    if (message.content) {
      message.content = encryptMessage(message.content, sender.encryptionKey);
    }

    next();
  } catch (err) {
    next(err);
  }
});

// Instance method: Decrypt content
groupMessageSchema.methods.decryptContent = async function () {
  const message = this;

  try {
    const sender = await mongoose.model('User').findById(message.senderId);
    if (!sender || !sender.encryptionKey) {
      throw new Error('Sender or encryption key not found');
    }

    const decryptedContent = message.content
      ? decryptMessage(message.content, sender.encryptionKey)
      : '';

    return {
      ...message._doc,
      content: decryptedContent,
    };
  } catch (err) {
    console.error('Error decrypting message:', err.message);
    return message._doc; // Return encrypted message as fallback
  }
};

const GroupMessage = mongoose.model('GroupMessage', groupMessageSchema);
module.exports = GroupMessage;
