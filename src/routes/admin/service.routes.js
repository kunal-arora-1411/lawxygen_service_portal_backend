import express from "express";

import {
  listServicesAdmin,
  createServiceAdmin,
  updateServiceAdmin,
  publishServiceAdmin,
  deleteServiceAdmin,
  getServiceStatsAdmin,
} from "../../controllers/admin/service.controller.js";

import { verifyJwt, verifyAdmin } from "../../middleware/auth.middleware.js";

const router = express.Router();

router.use(verifyJwt, verifyAdmin);

router.get("/stats", getServiceStatsAdmin);

router.get("/", listServicesAdmin);

router.post("/", createServiceAdmin);

router.patch("/:id", updateServiceAdmin);

router.patch("/:id/publish", publishServiceAdmin);

router.delete("/:id", deleteServiceAdmin);

export default router;
