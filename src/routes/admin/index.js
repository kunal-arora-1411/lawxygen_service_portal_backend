import { Router } from "express";

import authRoutes from "./auth.routes.js";
import serviceMatterRoutes from "./serviceMatter.routes.js";
import appointmentRoutes from "./appointment.routes.js";
import documentRoutes from "./document.routes.js";
import complianceRoutes from "./compliance.routes.js";
import conversationRoutes from "./conversation.routes.js";
import supportRoutes from "./support.routes.js";
import userRoutes from "./user.routes.js";
import professionalRoutes from "./professional.routes.js";
import serviceRoutes from "./service.routes.js";
import dashboardRoutes from "./dashboard.routes.js";
import { getAdminMe } from "../../controllers/admin/auth.controller.js";
import { verifyJwt, verifyAdmin } from "../../middleware/auth.middleware.js";

const router = Router();

router.use("/auth", authRoutes);

router.get("/me", verifyJwt, verifyAdmin, getAdminMe);

router.use("/service-matters", serviceMatterRoutes);
router.use("/appointments", appointmentRoutes);
router.use("/documents", documentRoutes);
router.use("/compliance", complianceRoutes);
router.use("/conversations", conversationRoutes);
router.use("/support", supportRoutes);
router.use("/users", userRoutes);
router.use("/professionals", professionalRoutes);
router.use("/services", serviceRoutes);
router.use("/dashboard", dashboardRoutes);

export default router;
