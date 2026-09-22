import express from "express";

import {
  listMyAppointments,
  createAppointment,
  updateMyAppointment,
  getMyAppointmentStats,
} from "../../controllers/client/appointment.controller.js";

import { verifyJwt } from "../../middleware/auth.middleware.js";

const router = express.Router();

router.use(verifyJwt);

router.get("/stats", getMyAppointmentStats);

router.get("/", listMyAppointments);

router.post("/", createAppointment);

router.patch("/:id", updateMyAppointment);

export default router;
