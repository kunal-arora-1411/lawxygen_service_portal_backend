import express from "express";

import {
  listServiceMatters,
  getServiceMatterById,
  updateServiceMatter,
  getServiceMatterStats,
} from "../../controllers/admin/serviceMatter.controller.js";

import { verifyJwt, verifyAdmin } from "../../middleware/auth.middleware.js";

const router = express.Router();

router.use(verifyJwt, verifyAdmin);

router.get("/stats", getServiceMatterStats);

router.get("/", listServiceMatters);

router.get("/:id", getServiceMatterById);

router.patch("/:id", updateServiceMatter);

export default router;
