import mongoose from "mongoose";
import Conversation from "../../models/conversation.model.js";
import Message from "../../models/message.model.js";
import ApiError from "../../utils/ApiError.js";
import ApiResponse from "../../utils/ApiResponse.js";
import asyncHandler from "../../utils/asyncHandler.js";

/**
 * GET /api/client/conversations
 */
export const listMyConversations = asyncHandler(async (req, res) => {
  const conversations = await Conversation.find({ client: req.user._id })
    .populate("participants", "name role")
    .populate("lastMessage.senderId", "name")
    .sort({ updatedAt: -1 })
    .lean();

  return res.status(200).json(
    new ApiResponse(200, conversations, "Conversations fetched successfully")
  );
});

/**
 * GET /api/client/conversations/:id/messages
 * query: before?, limit
 */
export const getConversationMessages = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { before, limit = 50 } = req.query;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError(400, "Invalid conversation ID");
  }

  const conversation = await Conversation.findOne({ _id: id, client: req.user._id });

  if (!conversation) {
    throw new ApiError(404, "Conversation not found");
  }

  const query = { conversation: id };

  if (before) {
    query.sentAt = { $lt: new Date(before) };
  }

  const messages = await Message.find(query)
    .populate("sender", "name role")
    .sort({ sentAt: -1 })
    .limit(Math.min(Number(limit) || 50, 100))
    .lean();

  return res.status(200).json(
    new ApiResponse(200, messages.reverse(), "Messages fetched successfully")
  );
});

/**
 * POST /api/client/conversations/:id/messages
 * body: { body, attachments? }
 */
export const sendMessageToConversation = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { body, attachments = [] } = req.body;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError(400, "Invalid conversation ID");
  }

  if (!body?.trim()) {
    throw new ApiError(400, "Message body is required");
  }

  const conversation = await Conversation.findOne({ _id: id, client: req.user._id });

  if (!conversation) {
    throw new ApiError(404, "Conversation not found");
  }

  const message = await Message.create({
    conversation: id,
    sender: req.user._id,
    body: body.trim(),
    attachments,
    sentAt: new Date(),
  });

  conversation.lastMessage = {
    body: message.body,
    senderId: message.sender,
    sentAt: message.sentAt,
  };

  await conversation.save();

  return res.status(201).json(
    new ApiResponse(201, message, "Message sent successfully")
  );
});

/**
 * POST /api/client/conversations/:id/read
 */
export const markConversationRead = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError(400, "Invalid conversation ID");
  }

  const conversation = await Conversation.findOneAndUpdate(
    { _id: id, client: req.user._id },
    { $set: { unreadCount: 0 } },
    { new: true }
  );

  if (!conversation) {
    throw new ApiError(404, "Conversation not found");
  }

  return res.status(200).json(
    new ApiResponse(200, conversation, "Conversation marked as read")
  );
});

/**
 * GET /api/client/conversations/stats
 */
export const getMyConversationStats = asyncHandler(async (req, res) => {
  const clientId = req.user._id;

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const conversations = await Conversation.find({ client: clientId }).lean();

  const unread = conversations.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
  const experts = new Set(conversations.flatMap((c) => (c.participants || []).map((p) => p.toString()))).size;
  const updatedToday = conversations.filter((c) => new Date(c.updatedAt) >= startOfToday).length;

  return res.status(200).json(
    new ApiResponse(
      200,
      { unread, conversations: conversations.length, experts, updatedToday },
      "Conversation stats fetched successfully"
    )
  );
});
