import { Router } from "express";

import {
  updateProfile,
  changePassword,
  deleteAccount,
} from "../../controllers/client/user.controller.js";

import { verifyJwt } from "../../middleware/auth.middleware.js";
import { getCurrentUser } from "../../controllers/client/auth.controller.js";

const router = Router();

router.patch("/me", verifyJwt, updateProfile);

router.patch("/me/password", verifyJwt, changePassword);

router.delete("/me", verifyJwt, deleteAccount);

router.get("/me", verifyJwt, getCurrentUser);

export default router;
