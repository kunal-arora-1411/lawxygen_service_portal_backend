import mongoose from "mongoose";
import Appointment from "../../models/appointment.model.js";
import { User } from "../../models/user.model.js";
import ApiError from "../../utils/ApiError.js";
import ApiResponse from "../../utils/ApiResponse.js";
import asyncHandler from "../../utils/asyncHandler.js";

/**
 * GET /api/admin/appointments
 * query: status?, date?, page, limit
 */
export const listAppointments = asyncHandler(async (req, res) => {
  const { status, date, page = 1, limit = 20 } = req.query;

  const query = {};

  if (status) {
    query.status = status;
  }

  if (date) {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);

    const end = new Date(date);
    end.setHours(23, 59, 59, 999);

    query.scheduledAt = { $gte: start, $lte: end };
  }

  const pageNumber = Math.max(Number(page), 1);
  const limitNumber = Math.min(Math.max(Number(limit), 1), 100);
  const skip = (pageNumber - 1) * limitNumber;

  const [items, total] = await Promise.all([
    Appointment.find(query)
      .populate("client", "name")
      .populate("professional", "name")
      .sort({ scheduledAt: 1 })
      .skip(skip)
      .limit(limitNumber)
      .lean(),

    Appointment.countDocuments(query),
  ]);

  return res.status(200).json(
    new ApiResponse(200, { items, total, page: pageNumber, limit: limitNumber }, "Appointments fetched successfully")
  );
});

/**
 * PATCH /api/admin/appointments/:id
 * body: { status?, professional?, scheduledAt? }
 */
export const updateAppointmentAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, professional, scheduledAt } = req.body;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError(400, "Invalid appointment ID");
  }

  const appointment = await Appointment.findById(id);

  if (!appointment) {
    throw new ApiError(404, "Appointment not found");
  }

  if (professional !== undefined) {
    if (professional === null) {
      appointment.professional = null;
    } else {
      if (!mongoose.Types.ObjectId.isValid(professional)) {
        throw new ApiError(400, "Invalid professional ID");
      }

      const professionalUser = await User.findOne({ _id: professional, role: "professional" });

      if (!professionalUser) {
        throw new ApiError(404, "Professional not found");
      }

      appointment.professional = professionalUser._id;
    }
  }

  if (status !== undefined) {
    const allowedStatuses = ["requested", "confirmed", "completed", "missed", "cancelled"];

    if (!allowedStatuses.includes(status)) {
      throw new ApiError(400, "Invalid appointment status");
    }

    appointment.status = status;
  }

  if (scheduledAt !== undefined) {
    appointment.scheduledAt = new Date(scheduledAt);
  }

  await appointment.save();

  const updated = await Appointment.findById(appointment._id)
    .populate("client", "name")
    .populate("professional", "name");

  return res.status(200).json(
    new ApiResponse(200, updated, "Appointment updated successfully")
  );
});

/**
 * GET /api/admin/appointments/stats
 */
export const getAppointmentStatsAdmin = asyncHandler(async (req, res) => {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);

  const [today, upcoming, pending, professionalsAvailable] = await Promise.all([
    Appointment.countDocuments({ scheduledAt: { $gte: startOfToday, $lte: endOfToday } }),
    Appointment.countDocuments({
      scheduledAt: { $gt: endOfToday },
      status: { $in: ["requested", "confirmed"] },
    }),
    Appointment.countDocuments({ status: "requested" }),
    User.countDocuments({ role: "professional", "professionalProfile.availability": "online" }),
  ]);

  return res.status(200).json(
    new ApiResponse(
      200,
      { today, upcoming, pending, professionalsAvailable },
      "Appointment stats fetched successfully"
    )
  );
});
