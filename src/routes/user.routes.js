import { Router } from "express";

import {
  updateProfile,
  changePassword,
  deleteAccount,
} from "../controllers/user.controller.js";

import { verifyJwt } from "../middleware/auth.middleware.js";

const router = Router();

router.patch("/me", verifyJwt, updateProfile);

router.patch(
  "/me/password",
  verifyJwt,
  changePassword
);

router.delete(
  "/me",
  verifyJwt,
  deleteAccount
);

export default router;