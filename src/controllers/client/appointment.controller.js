import mongoose from "mongoose";
import Appointment from "../../models/appointment.model.js";
import ApiError from "../../utils/ApiError.js";
import ApiResponse from "../../utils/ApiResponse.js";
import asyncHandler from "../../utils/asyncHandler.js";

/**
 * GET /api/client/appointments
 * query: status?, upcoming?
 */
export const listMyAppointments = asyncHandler(async (req, res) => {
  const { status, upcoming } = req.query;

  const query = { client: req.user._id };

  if (status) {
    query.status = status;
  }

  if (upcoming === "true") {
    query.scheduledAt = { $gte: new Date() };
    query.status = { $in: ["requested", "confirmed"] };
  }

  const appointments = await Appointment.find(query)
    .populate("professional", "name")
    .sort({ scheduledAt: 1 })
    .lean();

  return res.status(200).json(
    new ApiResponse(200, appointments, "Appointments fetched successfully")
  );
});

/**
 * POST /api/client/appointments
 * body: { serviceMatter?, scheduledAt, durationMinutes, mode, topic }
 */
export const createAppointment = asyncHandler(async (req, res) => {
  const { serviceMatter, scheduledAt, durationMinutes, mode, topic } = req.body;

  if (!scheduledAt) {
    throw new ApiError(400, "scheduledAt is required");
  }

  if (serviceMatter && !mongoose.Types.ObjectId.isValid(serviceMatter)) {
    throw new ApiError(400, "Invalid serviceMatter ID");
  }

  const appointment = await Appointment.create({
    client: req.user._id,
    serviceMatter: serviceMatter || null,
    scheduledAt: new Date(scheduledAt),
    durationMinutes: durationMinutes || 30,
    mode: mode || "video",
    topic: topic || "",
    status: "requested",
  });

  return res.status(201).json(
    new ApiResponse(201, appointment, "Appointment booked successfully")
  );
});

/**
 * PATCH /api/client/appointments/:id
 * body: { scheduledAt? } or { status: "cancelled" }
 */
export const updateMyAppointment = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { scheduledAt, status } = req.body;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError(400, "Invalid appointment ID");
  }

  const appointment = await Appointment.findOne({ _id: id, client: req.user._id });

  if (!appointment) {
    throw new ApiError(404, "Appointment not found");
  }

  if (status !== undefined) {
    if (status !== "cancelled") {
      throw new ApiError(400, "Clients may only cancel an appointment");
    }

    appointment.status = "cancelled";
  }

  if (scheduledAt !== undefined) {
    appointment.scheduledAt = new Date(scheduledAt);
    appointment.status = "requested";
  }

  await appointment.save();

  return res.status(200).json(
    new ApiResponse(200, appointment, "Appointment updated successfully")
  );
});

/**
 * GET /api/client/appointments/stats
 */
export const getMyAppointmentStats = asyncHandler(async (req, res) => {
  const clientId = req.user._id;

  const [upcoming, video, completed, missed] = await Promise.all([
    Appointment.countDocuments({
      client: clientId,
      scheduledAt: { $gte: new Date() },
      status: { $in: ["requested", "confirmed"] },
    }),
    Appointment.countDocuments({ client: clientId, mode: "video" }),
    Appointment.countDocuments({ client: clientId, status: "completed" }),
    Appointment.countDocuments({ client: clientId, status: "missed" }),
  ]);

  return res.status(200).json(
    new ApiResponse(200, { upcoming, video, completed, missed }, "Appointment stats fetched successfully")
  );
});
