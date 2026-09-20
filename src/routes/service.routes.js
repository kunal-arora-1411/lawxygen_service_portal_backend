import { Router } from "express";

import {
  assignServiceToUser,
  getUserServices,
  getUserServiceById,
} from "../controllers/service.controller.js";

import { verifyJwt } from "../middleware/auth.middleware.js";

const router = Router();

router.post(
  "/:serviceId/assign",
  verifyJwt,
  assignServiceToUser
);

router.get(
  "/my-services",
  verifyJwt,
  getUserServices
);

router.get(
  "/my-services/:serviceId",
  verifyJwt,
  getUserServiceById
);

export default router;