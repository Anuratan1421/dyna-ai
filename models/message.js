const mongoose = require("mongoose");
const crypto = require('crypto');

// Helper function to encrypt text with a user's specific key
const encryptMessage = (text, encryptionKey) => {
  const iv = crypto.randomBytes(16); // Initialization vector
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(encryptionKey, 'hex'), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex'); // Return IV with the encrypted message
};

// Helper function to decrypt text with a user's specific key
const decryptMessage = (encryptedText, encryptionKey) => {
  const textParts = encryptedText.split(':');
  const iv = Buffer.from(textParts.shift(), 'hex');
  const encryptedMessage = Buffer.from(textParts.join(':'), 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(encryptionKey, 'hex'), iv);
  let decrypted = decipher.update(encryptedMessage);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
};

// Define the Chat schema
const chatSchema = new mongoose.Schema({
  senderId: {
    type: String,
    required: true,
  },
  receiverId: {
    type: String,
    required: true,
  },
  message: {
    type: String,
    default: '', // Set default to empty string
  },
  imageUrl: {
    type: String, // Store the image URL
    default: null,
  },
  timestamp: {
    type: Date,
    default: Date.now,





  },




  
    senderId: {
      type: String,
      required: true,
    },
    receiverId: {
      type: String,
      required: true,
    },
    message: {
      type: String,
    },
    imageUrl: {
      type: String,
    },
    musicData: {
      type: Object,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },




});

// Add pre-save hook to encrypt messages before saving and validate message or imageUrl
chatSchema.pre('save', async function (next) {
  const chat = this;

  // Ensure at least one of message or imageUrl is provided
  if (!chat.message && !chat.imageUrl) {
    return next(new Error('Either message or imageUrl is required.'));
  }

  // Fetch the sender's encryption key from the User model
  const sender = await mongoose.model('User').findById(chat.senderId);
  if (!sender) {
    return next(new Error('Sender not found'));
  }

  // Encrypt the message if it exists
  if (chat.message) {
    chat.message = encryptMessage(chat.message, sender.encryptionKey);
  }

  next();
});

// Add a method to decrypt messages when retrieving
chatSchema.methods.decryptMessage = async function () {
  const chat = this;

  // Fetch the sender's encryption key from the User model
  const sender = await mongoose.model('User').findById(chat.senderId);
  if (!sender) {
    throw new Error('Sender not found');
  }

  // Decrypt the message if it exists
  if (chat.message) {
    return decryptMessage(chat.message, sender.encryptionKey);
  }

  return chat.message; // If message is empty, return as it is
};

const Chat = mongoose.model("Chat", chatSchema);

module.exports = Chat;


