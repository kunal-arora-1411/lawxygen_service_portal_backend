import express from "express";

import {
  listMyCompliance,
  getMyComplianceStats,
} from "../../controllers/client/compliance.controller.js";

import { verifyJwt } from "../../middleware/auth.middleware.js";

const router = express.Router();

router.use(verifyJwt);

router.get("/stats", getMyComplianceStats);

router.get("/", listMyCompliance);

export default router;
