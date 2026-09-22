import { Router } from "express";

import {
  adminLogin,
  adminLogout,
  adminRefreshToken,
} from "../../controllers/admin/auth.controller.js";

import { verifyJwt, verifyAdmin } from "../../middleware/auth.middleware.js";

const router = Router();

router.post("/login", adminLogin);

router.post("/refresh-token", adminRefreshToken);

router.post("/logout", verifyJwt, verifyAdmin, adminLogout);

export default router;
