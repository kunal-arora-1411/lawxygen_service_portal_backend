import express from "express";

import {
  assignServiceToLoggedInUser,
  getClientServiceMatters,
  getClientServiceMatter,
  resolveClientAction,
} from "../../controllers/client/serviceMatter.controller.js";

import { verifyJwt } from "../../middleware/auth.middleware.js";

const router = express.Router();

// Create service matter
router.post("/", verifyJwt, assignServiceToLoggedInUser);

// Get my services
router.get("/", verifyJwt, getClientServiceMatters);

// Get one of my services
router.get("/:matterId", verifyJwt, getClientServiceMatter);

// Resolve action requested by professional
router.patch("/:matterId/action/resolve", verifyJwt, resolveClientAction);

export default router;
