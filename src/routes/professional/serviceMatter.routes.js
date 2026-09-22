import express from "express";

import {
  getProfessionalServiceMatters,
  getProfessionalServiceMatter,
  updateMatterProgress,
  requestClientAction,
} from "../../controllers/professional/serviceMatter.controller.js";

import { verifyJwt, verifyProfessional } from "../../middleware/auth.middleware.js";

const router = express.Router();

router.use(verifyJwt, verifyProfessional);

// Get assigned services
router.get("/", getProfessionalServiceMatters);

// Get one assigned service
router.get("/:matterId", getProfessionalServiceMatter);

// Update progress
router.patch("/:matterId/progress", updateMatterProgress);

// Request action from client
router.patch("/:matterId/action", requestClientAction);

export default router;
