import { Router } from "express";

import {
  logoutUser,
  refreshAccessToken,
  getCurrentUser,
  emailAuth,
  sendPhoneOtp,
  verifyPhoneOtp,
} from "../controllers/auth.controller.js";

import { verifyJwt } from "../middleware/auth.middleware.js";

const router = Router();

router.post("/email", emailAuth);

router.post("/send-otp", sendPhoneOtp);

router.post("/verify-otp", verifyPhoneOtp);

// router.post("/google", loginUser);
// router.post("/facebook", loginUser);
// router.post("/apple", loginUser);

router.post("/refresh-token", refreshAccessToken);

router.post("/logout", verifyJwt, logoutUser);

router.get("/me", verifyJwt, getCurrentUser);

export default router;