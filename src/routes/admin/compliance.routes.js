import express from "express";

import {
  createComplianceAdmin,
  updateComplianceAdmin,
  listComplianceAdmin,
} from "../../controllers/admin/compliance.controller.js";

import { verifyJwt, verifyAdmin } from "../../middleware/auth.middleware.js";

const router = express.Router();

router.use(verifyJwt, verifyAdmin);

router.get("/", listComplianceAdmin);

router.post("/", createComplianceAdmin);

router.patch("/:id", updateComplianceAdmin);

export default router;
