import express from "express";

import {
  listSupportTicketsAdmin,
  updateSupportTicketAdmin,
  getSupportStatsAdmin,
} from "../../controllers/admin/support.controller.js";

import { verifyJwt, verifyAdmin } from "../../middleware/auth.middleware.js";

const router = express.Router();

router.use(verifyJwt, verifyAdmin);

router.get("/stats", getSupportStatsAdmin);

router.get("/tickets", listSupportTicketsAdmin);

router.patch("/tickets/:id", updateSupportTicketAdmin);

export default router;
