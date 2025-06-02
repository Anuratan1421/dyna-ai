const mongoose = require('mongoose');

const groupSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  hostId: {
    type: String,
    required: true
  },
  members: [{
    type: String,
    required: true
  }],
  avatar: {
    type: String,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  description: {
    type: String,
    default: ''
  },
  isPrivate: {
    type: Boolean,
    default: true
  }
});

// Add a method to check if a user is a member of the group
groupSchema.methods.isMember = function(userId) {
  return this.members.includes(userId);
};

// Add a method to check if a user is the host of the group
groupSchema.methods.isHost = function(userId) {
  return this.hostId === userId;
};

const Group = mongoose.model('Group', groupSchema);

module.exports = Group;