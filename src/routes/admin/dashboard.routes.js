import express from "express";

import {
  getAdminDashboardStats,
  getWeeklyWorkload,
  getNeedsAttention,
  getAdminDashboardActivity,
} from "../../controllers/admin/dashboard.controller.js";

import { verifyJwt, verifyAdmin } from "../../middleware/auth.middleware.js";

const router = express.Router();

router.use(verifyJwt, verifyAdmin);

router.get("/stats", getAdminDashboardStats);

router.get("/weekly-workload", getWeeklyWorkload);

router.get("/needs-attention", getNeedsAttention);

router.get("/activity", getAdminDashboardActivity);

export default router;
