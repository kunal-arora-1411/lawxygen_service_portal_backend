import express from "express";

import {
  listUsers,
  listAllUsers,
  getUserById,
  getUserStats,
} from "../../controllers/admin/user.controller.js";

import { verifyJwt, verifyAdmin } from "../../middleware/auth.middleware.js";

const router = express.Router();

router.use(verifyJwt, verifyAdmin);

router.get("/stats", getUserStats);

router.get("/all", listAllUsers);

router.get("/", listUsers);

router.get("/:id", getUserById);

export default router;
