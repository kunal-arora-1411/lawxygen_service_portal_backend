import express from "express";

import {
  listAppointments,
  updateAppointmentAdmin,
  getAppointmentStatsAdmin,
} from "../../controllers/admin/appointment.controller.js";

import { verifyJwt, verifyAdmin } from "../../middleware/auth.middleware.js";

const router = express.Router();

router.use(verifyJwt, verifyAdmin);

router.get("/stats", getAppointmentStatsAdmin);

router.get("/", listAppointments);

router.patch("/:id", updateAppointmentAdmin);

export default router;
