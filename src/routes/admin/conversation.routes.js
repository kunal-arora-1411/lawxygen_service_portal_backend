import express from "express";

import {
  listConversationsAdmin,
  sendMessageAsAdmin,
} from "../../controllers/admin/conversation.controller.js";

import { verifyJwt, verifyAdmin } from "../../middleware/auth.middleware.js";

const router = express.Router();

router.use(verifyJwt, verifyAdmin);

router.get("/", listConversationsAdmin);

router.post("/:id/messages", sendMessageAsAdmin);

export default router;
