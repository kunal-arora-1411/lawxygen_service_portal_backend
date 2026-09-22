import mongoose from "mongoose";
import Conversation from "../../models/conversation.model.js";
import Message from "../../models/message.model.js";
import ApiError from "../../utils/ApiError.js";
import ApiResponse from "../../utils/ApiResponse.js";
import asyncHandler from "../../utils/asyncHandler.js";

/**
 * GET /api/admin/conversations
 * query: unread?, page, limit
 *
 * unread=true returns conversations whose latest message is from the
 * client, i.e. still awaiting a staff reply.
 */
export const listConversationsAdmin = asyncHandler(async (req, res) => {
  const { unread, page = 1, limit = 20 } = req.query;

  const query = {};

  if (unread === "true") {
    query.$expr = { $eq: ["$lastMessage.senderId", "$client"] };
  }

  const pageNumber = Math.max(Number(page), 1);
  const limitNumber = Math.min(Math.max(Number(limit), 1), 100);
  const skip = (pageNumber - 1) * limitNumber;

  const [items, total] = await Promise.all([
    Conversation.find(query)
      .populate("client", "name email")
      .populate("participants", "name role")
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limitNumber)
      .lean(),

    Conversation.countDocuments(query),
  ]);

  return res.status(200).json(
    new ApiResponse(200, { items, total, page: pageNumber, limit: limitNumber }, "Conversations fetched successfully")
  );
});

/**
 * POST /api/admin/conversations/:id/messages
 * body: { body, attachments? }
 */
export const sendMessageAsAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { body, attachments = [] } = req.body;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError(400, "Invalid conversation ID");
  }

  if (!body?.trim()) {
    throw new ApiError(400, "Message body is required");
  }

  const conversation = await Conversation.findById(id);

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

  conversation.unreadCount = (conversation.unreadCount || 0) + 1;

  const alreadyParticipant = conversation.participants.some(
    (participantId) => participantId.toString() === req.user._id.toString()
  );

  if (!alreadyParticipant) {
    conversation.participants.push(req.user._id);
  }

  await conversation.save();

  return res.status(201).json(
    new ApiResponse(201, message, "Reply sent successfully")
  );
});
