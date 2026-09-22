import express from "express";

import {
  getAllServices,
  getServiceBySlug,
  getServicesByCategory,
} from "../../controllers/client/service.controller.js";

const router = express.Router();

// Get all services
router.get("/", getAllServices);

// Get services by category
router.get("/category/:categorySlug", getServicesByCategory);

// Get single service by slug
router.get("/slug/:slug", getServiceBySlug);

export default router;
