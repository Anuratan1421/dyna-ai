// Enhanced server implementation with Socket.io for real-time features
import express from "express"
import cors from "cors"
import bodyParser from "body-parser"
import dotenv from "dotenv"
import mongoose from "mongoose"
import { ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings } from "@langchain/google-genai"
import { ConversationChain } from "langchain/chains"
import { BufferMemory } from "langchain/memory"
import { Pinecone } from "@pinecone-database/pinecone"
import { PineconeStore } from "@langchain/community/vectorstores/pinecone"
import { PromptTemplate } from "@langchain/core/prompts"
import http from "http"
import { Server } from "socket.io"

import Group from "./models/Group.js"
import GroupMessage from "./models/GroupMessage.js"

dotenv.config()

const app = express()
app.use(cors())
app.use(bodyParser.json())

const server = http.createServer(app)

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
})

// Connect to MongoDB
mongoose
  .connect("mongodb+srv://anuratan:Anuratan%401421@cluster0.0uo5r.mongodb.net/?retryWrites=true&w=majority")
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("MongoDB connection error:", err))

// Define Message Schema
const messageSchema = new mongoose.Schema({
  senderId: {
    type: String,
    required: true,
  },
  receiverId: {
    type: String,
    required: true,
  },
  content: {
    type: String,
    required: true,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
})

// Define User Schema for consent management
const AiuserSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    unique: true,
  },
  hasConsented: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  email: {
    type: String,
    required: false,
  },
})

const Message = mongoose.model("Message", messageSchema)
const User = mongoose.model("AiUser", AiuserSchema)

const memoryMap = {} // userId -> Chain
const vectorStoreMap = {} // userId -> Pinecone vector store
const activeConnections = new Map() // userId -> socketId
const typingUsers = new Map() // groupId -> [userId1, userId2, ...]

// Pinecone config
const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY,
})

// Get the index name from environment or use the hardcoded value
const INDEX_NAME = process.env.PINECONE_INDEX_NAME || "dnyanu"

// Function to initialize conversation history from MongoDB
async function loadConversationHistory(userId) {
  try {
    // Get past messages between this user and the AI
    const pastMessages = await Message.find({
      $or: [
        { senderId: userId, receiverId: "dnya" },
        { senderId: "dnya", receiverId: userId },
      ],
    })
      .sort({ timestamp: 1 })
      .limit(20) // Get the last 20 messages

    // Format past messages as a conversation history
    const history = []
    for (const msg of pastMessages) {
      if (msg.senderId === userId) {
        history.push({ type: "human", text: msg.content })
      } else {
        history.push({ type: "ai", text: msg.content })
      }
    }

    return history
  } catch (error) {
    console.error("Error loading conversation history:", error)
    return []
  }
}

// Create a user-specific chatbot chain
async function createUserChain(userId) {
  try {
    // 1. Create embedding model
    const embeddings = new GoogleGenerativeAIEmbeddings({
      modelName: "embedding-001",
      apiKey: process.env.GEMINI_API_KEY,
    })

    // 2. Connect to Pinecone index
    const pineconeIndex = pinecone.Index(INDEX_NAME)

    // 3. Create or connect to vector store for this user
    const namespace = `user-${userId}`
    let vectorStore

    try {
      // Try to connect to existing vector store
      vectorStore = await PineconeStore.fromExistingIndex(embeddings, {
        pineconeIndex,
        namespace,
      })
    } catch (error) {
     // console.log("Vector store not found, creating new one:", error.message)

      // Create new vector store if it doesn't exist
      vectorStore = await PineconeStore.fromDocuments(
        [{ pageContent: "Initial message for user", metadata: { userId } }],
        embeddings,
        { pineconeIndex, namespace },
      )
    }

    vectorStoreMap[userId] = vectorStore

    // 4. Set up chat model
    const model = new ChatGoogleGenerativeAI({
      model: "gemini-1.5-flash",
      temperature: 0.7,
      apiKey: process.env.GEMINI_API_KEY,
    })

    // 5. Load conversation history
    const pastMessages = await loadConversationHistory(userId)

    // 6. Create memory with past messages
    const memory = new BufferMemory({
      returnMessages: true,
      memoryKey: "history",
      inputKey: "input",
    })

    // Pre-load the memory with past conversations
    if (pastMessages.length > 0) {
      for (let i = 0; i < pastMessages.length - 1; i += 2) {
        if (pastMessages[i] && pastMessages[i + 1]) {
          await memory.saveContext({ input: pastMessages[i].text }, { output: pastMessages[i + 1].text })
        }
      }
    }

    // 7. Create a basic conversation chain with memory
    const chain = new ConversationChain({
      llm: model,
      memory: memory,
      prompt: PromptTemplate.fromTemplate(
        `You are Dyna, a helpful and context-aware assistant. The following is a conversation between you and a human user.
        
        History: {history}
        Human: {input}
        AI: `,
      ),
    })

    memoryMap[userId] = {
      chain: chain,
      vectorStore: vectorStore,
    }

    return chain
  } catch (error) {
    console.error("Error creating user chain:", error)

    // Fall back to basic conversation without retrieval
    const model = new ChatGoogleGenerativeAI({
      model: "gemini-1.5-flash",
      temperature: 0.7,
      apiKey: process.env.GEMINI_API_KEY,
    })

    const memory = new BufferMemory({
      returnMessages: true,
      memoryKey: "history",
      inputKey: "input",
    })

    // Load conversation history into memory
    const pastMessages = await loadConversationHistory(userId)
    if (pastMessages.length > 0) {
      for (let i = 0; i < pastMessages.length - 1; i += 2) {
        if (pastMessages[i] && pastMessages[i + 1]) {
          await memory.saveContext({ input: pastMessages[i].text }, { output: pastMessages[i + 1].text })
        }
      }
    }

    const chain = new ConversationChain({
      llm: model,
      memory: memory,
      prompt: PromptTemplate.fromTemplate(
        `You are Dyna, a helpful and context-aware assistant. The following is a conversation between you and a human user.
        
        History: {history}
        Human: {input}
        AI: `,
      ),
    })
    memoryMap[userId] = {
      chain: chain,
      vectorStore: null,
    }
    return chain
  }
}

// Get or create user
app.post("/api/users", async (req, res) => {
  try {
    const { userId, email } = req.body

    if (!userId) {
      return res.status(400).json({ error: "User ID is required" })
    }

    // Find user or create if doesn't exist
    let user = await User.findOne({ userId })

    if (!user) {
      user = new User({ userId, email })
      await user.save()
    }

    res.json({ user })
  } catch (error) {
    console.error("Error:", error)
    res.status(500).json({ error: "Server error" })
  }
})

// Update user consent
app.put("/api/users/consent", async (req, res) => {
  try {
    const { userId, hasConsented } = req.body

    if (!userId) {
      return res.status(400).json({ error: "User ID is required" })
    }

    const user = await User.findOneAndUpdate({ userId }, { hasConsented }, { new: true, upsert: true })

    res.json({ user })
  } catch (error) {
    console.error("Error:", error)
    res.status(500).json({ error: "Server error" })
  }
})

// Get messages between user and Dnya
app.get("/api/messages/:userId/dnya", async (req, res) => {
  try {
    const { userId } = req.params

    const messages = await Message.find({
      $or: [
        { senderId: userId, receiverId: "dnya" },
        { senderId: "dnya", receiverId: userId },
      ],
    }).sort({ timestamp: 1 })

    res.json({ messages })
  } catch (error) {
    console.error("Error fetching messages:", error)
    res.status(500).json({ error: "Failed to fetch messages" })
  }
})

// Send message and get AI response
app.post("/api/messages", async (req, res) => {
  try {
    const { senderId, content } = req.body

    if (!senderId || !content) {
      return res.status(400).json({ error: "Sender ID and content are required" })
    }

    // Check if user has consented
    const user = await User.findOne({ userId: senderId })

    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }

    if (!user.hasConsented) {
      return res.status(403).json({ error: "User has not consented to AI chat" })
    }

    // Save user message to MongoDB
    const userMessage = new Message({
      senderId,
      receiverId: "dnya",
      content,
    })
    await userMessage.save()

    // Make sure we have a chain for this user
    if (!memoryMap[senderId]) {
      await createUserChain(senderId)
    }

    // Get similar messages from vector store for context
    let similarDocuments = []
    try {
      if (memoryMap[senderId].vectorStore) {
        similarDocuments = await memoryMap[senderId].vectorStore.similaritySearch(content, 3)
        // console.log(
        //   "Retrieved similar documents:",
        //   similarDocuments.map((doc) => doc.pageContent),
        // )
      }
    } catch (error) {
      //console.log("Error retrieving similar documents:", error.message)
    }

    // Store message in vector database for future retrieval
    try {
      if (memoryMap[senderId].vectorStore) {
        await memoryMap[senderId].vectorStore.addDocuments([
          {
            pageContent: content,
            metadata: {
              userId: senderId,
              timestamp: new Date().toISOString(),
              type: "user_message",
            },
          },
        ])
      }
    } catch (error) {
     // console.log("Error storing message in vector store:", error.message)
    }

    // Generate response from model with memory
    let result
    try {
      // If we have similar documents, include them in the input
      let contextEnhancedPrompt = content
      if (similarDocuments.length > 0) {
        const relevantContext = similarDocuments.map((doc) => doc.pageContent).join("\n\n")

        contextEnhancedPrompt = `Context from past conversations: 
${relevantContext}

Based on this context and our conversation history, please respond to: ${content}`
      }

      result = await memoryMap[senderId].chain.call({
        input: contextEnhancedPrompt,
      })
    } catch (error) {
      console.error("Error with chain call:", error)

      // If chain fails, fallback to a basic model call
      const model = new ChatGoogleGenerativeAI({
        model: "gemini-1.5-flash",
        temperature: 0.7,
        apiKey: process.env.GEMINI_API_KEY,
      })

      try {
        const response = await model.invoke(content)
        result = { response: response.text() }
      } catch (innerError) {
        console.error("Error with direct model call:", innerError)
        result = { response: "I'm sorry, I couldn't generate a response due to a technical issue." }
      }
    }

    const aiResponse = result.response || "I'm sorry, I couldn't generate a response."

    // Save AI response to MongoDB
    const aiMessage = new Message({
      senderId: "dnya",
      receiverId: senderId,
      content: aiResponse,
    })
    await aiMessage.save()

    // Also store AI response in vector database
    try {
      if (memoryMap[senderId].vectorStore) {
        await memoryMap[senderId].vectorStore.addDocuments([
          {
            pageContent: aiResponse,
            metadata: {
              userId: senderId,
              timestamp: new Date().toISOString(),
              type: "ai_response",
            },
          },
        ])
      }
    } catch (error) {
      console.log("Error storing AI response in vector store:", error.message)
    }

    // Emit the message to the user if they're connected via socket
    const socketId = activeConnections.get(senderId)
    if (socketId) {
      io.to(socketId).emit("ai:message", {
        message: aiMessage,
      })
    }

    res.json({
      userMessage,
      aiMessage,
    })
  } catch (error) {
    console.error("Error:", error)
    res.status(500).json({ error: "AI failed to respond", details: error.message })
  }
})

// Legacy endpoint for backward compatibility
app.post("/api/generate-response", async (req, res) => {
  try {
    const { message, userId } = req.body

    if (!message || !userId) {
      return res.status(400).json({ error: "Message and userId are required" })
    }

    // Save user message to MongoDB
    const userMessage = new Message({
      senderId: userId,
      receiverId: "dnya",
      content: message,
    })
    await userMessage.save()

    // If new user, initialize chain
    if (!memoryMap[userId]) {
      await createUserChain(userId)
    }

    // Get similar messages from vector store for context
    let similarDocuments = []
    try {
      if (memoryMap[userId].vectorStore) {
        similarDocuments = await memoryMap[userId].vectorStore.similaritySearch(message, 3)
        // console.log(
        //   "Retrieved similar documents:",
        //   similarDocuments.map((doc) => doc.pageContent),
        // )
      }
    } catch (error) {
      console.log("Error retrieving similar documents:", error.message)
    }

    // Store message in vector database
    try {
      if (memoryMap[userId].vectorStore) {
        await memoryMap[userId].vectorStore.addDocuments([
          {
            pageContent: message,
            metadata: {
              userId,
              timestamp: new Date().toISOString(),
              type: "user_message",
            },
          },
        ])
      }
    } catch (error) {
      console.log("Error storing message:", error.message)
    }

    // Generate response with memory and retrieved context
    let result
    try {
      // If we have similar documents, include them in the input
      let contextEnhancedPrompt = message
      if (similarDocuments.length > 0) {
        const relevantContext = similarDocuments.map((doc) => doc.pageContent).join("\n\n")

        contextEnhancedPrompt = `Context from past conversations: 
${relevantContext}

Based on this context and our conversation history, please respond to: ${message}`
      }

      result = await memoryMap[userId].chain.call({
        input: contextEnhancedPrompt,
      })
    } catch (error) {
      console.error("Error with chain call:", error)

      // If chain fails, fallback to a basic model call
      const model = new ChatGoogleGenerativeAI({
        model: "gemini-1.5-flash",
        temperature: 0.7,
        apiKey: process.env.GEMINI_API_KEY,
      })

      try {
        const response = await model.invoke(message)
        result = { response: response.text() }
      } catch (innerError) {
        console.error("Error with direct model call:", innerError)
        result = { response: "I'm sorry, I couldn't generate a response due to a technical issue." }
      }
    }

    const aiResponse = result.response || "I'm sorry, I couldn't generate a response."

    // Save AI response to MongoDB
    const aiMessage = new Message({
      senderId: "dnya",
      receiverId: userId,
      content: aiResponse,
    })
    await aiMessage.save()

    // Also store AI response in vector database
    try {
      if (memoryMap[userId].vectorStore) {
        await memoryMap[userId].vectorStore.addDocuments([
          {
            pageContent: aiResponse,
            metadata: {
              userId,
              timestamp: new Date().toISOString(),
              type: "ai_response",
            },
          },
        ])
      }
    } catch (error) {
      console.log("Error storing AI response in vector store:", error.message)
    }

    res.json({ reply: aiResponse, userId })
  } catch (error) {
    console.error("Error:", error)
    res.status(500).json({ error: "AI failed to respond", details: error.message })
  }
})

// Group API endpoints
app.post("/api/groups", async (req, res) => {
  try {
    const { name, hostId, members } = req.body

    if (!name || !hostId || !members || !Array.isArray(members)) {
      return res.status(400).json({ error: "Invalid group data" })
    }

    // Ensure host is included in members
    if (!members.includes(hostId)) {
      members.push(hostId)
    }

    const newGroup = new Group({
      name,
      hostId,
      members,
    })

    await newGroup.save()

    res.status(201).json({ group: newGroup })
  } catch (error) {
    console.error("Error creating group:", error)
    res.status(500).json({ error: "Failed to create group" })
  }
})

// Get all groups for a user
app.get("/api/groups/user/:userId", async (req, res) => {
  try {
    const { userId } = req.params

    const groups = await Group.find({ members: userId })

    res.status(200).json({ groups })
  } catch (error) {
    console.error("Error fetching groups:", error)
    res.status(500).json({ error: "Failed to fetch groups" })
  }
})

// Get a specific group
app.get("/api/groups/:groupId", async (req, res) => {
  try {
    const { groupId } = req.params

    const group = await Group.findById(groupId)

    if (!group) {
      return res.status(404).json({ error: "Group not found" })
    }

    res.status(200).json({ group })
  } catch (error) {
    console.error("Error fetching group:", error)
    res.status(500).json({ error: "Failed to fetch group" })
  }
})

// Update a group
app.put("/api/groups/:groupId", async (req, res) => {
  try {
    const { groupId } = req.params
    const { name, members, avatar } = req.body

    const group = await Group.findById(groupId)

    if (!group) {
      return res.status(404).json({ error: "Group not found" })
    }

    // Update fields if provided
    if (name) group.name = name
    if (members && Array.isArray(members)) group.members = members
    if (avatar) group.avatar = avatar

    group.updatedAt = Date.now()

    await group.save()

    res.status(200).json({ group })
  } catch (error) {
    console.error("Error updating group:", error)
    res.status(500).json({ error: "Failed to update group" })
  }
})

// Delete a group
app.delete("/api/groups/:groupId", async (req, res) => {
  try {
    const { groupId } = req.params
    const { userId } = req.body

    const group = await Group.findById(groupId)

    if (!group) {
      return res.status(404).json({ error: "Group not found" })
    }

    // Check if the user is the host
    if (group.hostId !== userId) {
      return res.status(403).json({ error: "Only the host can delete the group" })
    }

    // Delete the group and all its messages
    await Group.findByIdAndDelete(groupId)
    await GroupMessage.deleteMany({ groupId })

    res.status(200).json({ message: "Group deleted successfully" })
  } catch (error) {
    console.error("Error deleting group:", error)
    res.status(500).json({ error: "Failed to delete group" })
  }
})

// Add a member to a group
app.post("/api/groups/:groupId/members", async (req, res) => {
  try {
    const { groupId } = req.params
    const { userId, newMemberId } = req.body

    const group = await Group.findById(groupId)

    if (!group) {
      return res.status(404).json({ error: "Group not found" })
    }

    // Check if the user is the host
    if (group.hostId !== userId) {
      return res.status(403).json({ error: "Only the host can add members" })
    }

    // Check if the member is already in the group
    if (group.members.includes(newMemberId)) {
      return res.status(400).json({ error: "User is already a member of this group" })
    }

    // Add the new member
    group.members.push(newMemberId)
    group.updatedAt = Date.now()

    await group.save()

    res.status(200).json({ group })
  } catch (error) {
    console.error("Error adding member:", error)
    res.status(500).json({ error: "Failed to add member" })
  }
})

// Remove a member from a group
app.delete("/api/groups/:groupId/members/:memberId", async (req, res) => {
  try {
    const { groupId, memberId } = req.params
    const { userId } = req.body

    const group = await Group.findById(groupId)

    if (!group) {
      return res.status(404).json({ error: "Group not found" })
    }

    // Check if the user is the host or the member being removed is the user themselves
    if (group.hostId !== userId && userId !== memberId) {
      return res.status(403).json({ error: "Not authorized to remove this member" })
    }

    // Cannot remove the host
    if (memberId === group.hostId) {
      return res.status(400).json({ error: "Cannot remove the host from the group" })
    }

    // Remove the member
    group.members = group.members.filter((id) => id !== memberId)
    group.updatedAt = Date.now()

    await group.save()

    res.status(200).json({ group })
  } catch (error) {
    console.error("Error removing member:", error)
    res.status(500).json({ error: "Failed to remove member" })
  }
})

// Send a message to a group
app.post("/api/groups/:groupId/messages", async (req, res) => {
  try {
    const { groupId } = req.params
    const { senderId, senderName, content, imageUrl } = req.body

    // Check if the group exists
    const group = await Group.findById(groupId)

    if (!group) {
      return res.status(404).json({ error: "Group not found" })
    }

    // Check if the sender is a member of the group
    if (!group.members.includes(senderId)) {
      return res.status(403).json({ error: "Not a member of this group" })
    }

    // Create and save the message
    const newMessage = new GroupMessage({
      groupId,
      senderId,
      senderName,
      content,
      imageUrl,
    })

    await newMessage.save()

    // Emit the message to all group members via Socket.io
    const message = await newMessage.decryptContent()

    // Emit to all connected group members
    group.members.forEach((memberId) => {
      const socketId = activeConnections.get(memberId)
      if (socketId) {
        io.to(socketId).emit("group:message", { groupId, message })
      }
    })

    res.status(201).json({ message })
  } catch (error) {
    console.error("Error sending group message:", error)
    res.status(500).json({ error: "Failed to send message" })
  }
})

// Get messages for a group
app.get("/api/groups/:groupId/messages", async (req, res) => {
  try {
    const { groupId } = req.params
    const { userId } = req.query

    // Check if the group exists
    const group = await Group.findById(groupId)

    if (!group) {
      return res.status(404).json({ error: "Group not found" })
    }

    // Check if the user is a member of the group
    if (!group.members.includes(userId)) {
      return res.status(403).json({ error: "Not a member of this group" })
    }

    // Get messages
    const messages = await GroupMessage.find({ groupId }).sort({ timestamp: 1 })

    // Decrypt messages
    const decryptedMessages = await Promise.all(messages.map((message) => message.decryptContent()))

    res.status(200).json({ messages: decryptedMessages })
  } catch (error) {
    console.error("Error fetching group messages:", error)
    res.status(500).json({ error: "Failed to fetch messages" })
  }
})

// Socket.io connection handling
io.on("connection", (socket) => {
 // console.log("New client connected:", socket.id)

  // Store user connection
  socket.on("user:connect", ({ userId }) => {
    activeConnections.set(userId, socket.id)
   // console.log(`User ${userId} connected with socket ${socket.id}`)
  })

  // Join a group chat room
  socket.on("group:join", ({ groupId, userId }) => {
    socket.join(`group:${groupId}`)
   // console.log(`User ${userId} joined group ${groupId}`)

    // Add user to the room
    if (!socket.rooms.has(`group:${groupId}`)) {
      socket.join(`group:${groupId}`)
    }
  })

  // Leave a group chat room
  socket.on("group:leave", ({ groupId, userId }) => {
    socket.leave(`group:${groupId}`)
   // console.log(`User ${userId} left group ${groupId}`)
  })

  // Handle typing status
  socket.on("group:typing", ({ groupId, userId, userName, isTyping }) => {
    // Update typing users for this group
    if (!typingUsers.has(groupId)) {
      typingUsers.set(groupId, new Map())
    }

    const groupTypingUsers = typingUsers.get(groupId)

    if (isTyping) {
      groupTypingUsers.set(userId, userName)
    } else {
      groupTypingUsers.delete(userId)
    }

    // Broadcast typing status to all members in the group
    socket.to(`group:${groupId}`).emit("group:typing", {
      groupId,
      userId,
      userName,
      isTyping,
    })
  })

  // Send a message to a group
  socket.on("group:sendMessage", async ({ groupId, senderId, senderName, content, imageUrl }) => {
    try {
      // Check if the group exists
      const group = await Group.findById(groupId)

      if (!group) {
        socket.emit("error", { message: "Group not found" })
        return
      }

      // Check if the sender is a member of the group
      if (!group.members.includes(senderId)) {
        socket.emit("error", { message: "Not a member of this group" })
        return
      }

      // Create and save the message
      const newMessage = new GroupMessage({
        groupId,
        senderId,
        senderName,
        content,
        imageUrl,
      })

      await newMessage.save()

      // Clear typing indicator for this user
      if (typingUsers.has(groupId)) {
        const groupTypingUsers = typingUsers.get(groupId)
        groupTypingUsers.delete(senderId)

        // Broadcast updated typing status
        io.to(`group:${groupId}`).emit("group:typing", {
          groupId,
          userId: senderId,
          userName: senderName,
          isTyping: false,
        })
      }

      // Emit the message to all group members
      const message = await newMessage.decryptContent()
      io.to(`group:${groupId}`).emit("group:message", { groupId, message })
    } catch (error) {
      console.error("Error sending group message:", error)
      socket.emit("error", { message: "Failed to send message" })
    }
  })

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id)

    // Remove user from active connections
    for (const [userId, socketId] of activeConnections.entries()) {
      if (socketId === socket.id) {
        activeConnections.delete(userId)
      //  console.log(`User ${userId} disconnected`)

        // Clear typing status for this user in all groups
        for (const [groupId, groupTypingUsers] of typingUsers.entries()) {
          if (groupTypingUsers.has(userId)) {
            const userName = groupTypingUsers.get(userId)
            groupTypingUsers.delete(userId)

            // Broadcast updated typing status
            io.to(`group:${groupId}`).emit("group:typing", {
              groupId,
              userId,
              userName,
              isTyping: false,
            })
          }
        }

        break
      }
    }
  })
})

const PORT = process.env.PORT || 6000
server.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`)
})
