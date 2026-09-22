import express from "express";

import {
  getClientDashboardStats,
  getClientDashboardActivity,
} from "../../controllers/client/dashboard.controller.js";

import { verifyJwt } from "../../middleware/auth.middleware.js";

const router = express.Router();

router.use(verifyJwt);

router.get("/stats", getClientDashboardStats);

router.get("/activity", getClientDashboardActivity);

export default router;
