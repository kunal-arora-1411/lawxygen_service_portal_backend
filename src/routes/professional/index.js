import { Router } from "express";

import serviceMatterRoutes from "./serviceMatter.routes.js";

const router = Router();

router.use("/service-matters", serviceMatterRoutes);

export default router;
