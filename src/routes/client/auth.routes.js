import { Router } from "express";

import {
  logoutUser,
  refreshAccessToken,
  emailAuth,
  sendPhoneOtp,
  verifyPhoneOtp,
  testEmail,
  forgotPassword,
  verifyResetOtp,
  resetPassword,
} from "../../controllers/client/auth.controller.js";

import { verifyJwt } from "../../middleware/auth.middleware.js";
import {
  facebookAuth,
  googleAuth,
} from "../../controllers/client/socialAuth.controller.js";

const router = Router();

router.post("/email", emailAuth);

router.post("/phone/send-otp", sendPhoneOtp);

router.post("/phone/verify-otp", verifyPhoneOtp);

router.post("/google", googleAuth);

router.post("/facebook", facebookAuth);

router.post("/refresh-token", refreshAccessToken);

router.post("/logout", verifyJwt, logoutUser);

router.post("/forgot-password", forgotPassword);

router.post("/verify-reset-otp", verifyResetOtp);

router.post("/reset-password", resetPassword);

export default router;
