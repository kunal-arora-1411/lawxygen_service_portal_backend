import express from "express";

import {
  createSupportTicket,
  listMySupportTickets,
} from "../../controllers/client/support.controller.js";

import { verifyJwt } from "../../middleware/auth.middleware.js";

const router = express.Router();

router.use(verifyJwt);

router.get("/tickets", listMySupportTickets);

router.post("/tickets", createSupportTicket);

export default router;
