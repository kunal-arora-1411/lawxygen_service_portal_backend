import express from "express";

import {
  listMyConversations,
  getConversationMessages,
  sendMessageToConversation,
  markConversationRead,
  getMyConversationStats,
} from "../../controllers/client/conversation.controller.js";

import { verifyJwt } from "../../middleware/auth.middleware.js";

const router = express.Router();

router.use(verifyJwt);

router.get("/stats", getMyConversationStats);

router.get("/", listMyConversations);

router.get("/:id/messages", getConversationMessages);

router.post("/:id/messages", sendMessageToConversation);

router.post("/:id/read", markConversationRead);

export default router;
