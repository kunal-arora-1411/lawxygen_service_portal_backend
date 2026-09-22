import { Router } from "express";

import authRoutes from "./auth.routes.js";
import userRoutes from "./user.routes.js";
import serviceRoutes from "./service.routes.js";
import serviceMatterRoutes from "./serviceMatter.routes.js";
import appointmentRoutes from "./appointment.routes.js";
import documentRoutes from "./document.routes.js";
import complianceRoutes from "./compliance.routes.js";
import conversationRoutes from "./conversation.routes.js";
import supportRoutes from "./support.routes.js";
import dashboardRoutes from "./dashboard.routes.js";

const router = Router();

router.use("/auth", authRoutes);
router.use("/users", userRoutes);
router.use("/services", serviceRoutes);
router.use("/serviceMatter", serviceMatterRoutes);
router.use("/appointments", appointmentRoutes);
router.use("/documents", documentRoutes);
router.use("/compliance", complianceRoutes);
router.use("/conversations", conversationRoutes);
router.use("/support", supportRoutes);
router.use("/dashboard", dashboardRoutes);

export default router;
