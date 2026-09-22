import express from "express";

import {
  listProfessionals,
  createProfessional,
  updateProfessional,
  getProfessionalStats,
} from "../../controllers/admin/professional.controller.js";

import { verifyJwt, verifyAdmin } from "../../middleware/auth.middleware.js";

const router = express.Router();

router.use(verifyJwt, verifyAdmin);

router.get("/stats", getProfessionalStats);

router.get("/", listProfessionals);

router.post("/", createProfessional);

router.patch("/:id", updateProfessional);

export default router;
