import mongoose from "mongoose";
import SupportTicket from "../../models/supportTicket.model.js";
import ApiError from "../../utils/ApiError.js";
import ApiResponse from "../../utils/ApiResponse.js";
import asyncHandler from "../../utils/asyncHandler.js";

/**
 * POST /api/client/support/tickets
 * body: { subject, serviceMatter?, language? }
 */
export const createSupportTicket = asyncHandler(async (req, res) => {
  const { subject, serviceMatter, language } = req.body;

  if (!subject?.trim()) {
    throw new ApiError(400, "Subject is required");
  }

  if (serviceMatter && !mongoose.Types.ObjectId.isValid(serviceMatter)) {
    throw new ApiError(400, "Invalid serviceMatter ID");
  }

  const ticket = await SupportTicket.create({
    client: req.user._id,
    serviceMatter: serviceMatter || null,
    subject: subject.trim(),
    language: language || null,
    status: "waiting",
    waitStartedAt: new Date(),
  });

  return res.status(201).json(
    new ApiResponse(201, ticket, "Support ticket created successfully")
  );
});

/**
 * GET /api/client/support/tickets
 */
export const listMySupportTickets = asyncHandler(async (req, res) => {
  const tickets = await SupportTicket.find({ client: req.user._id })
    .populate("serviceMatter", "serviceSnapshot")
    .sort({ createdAt: -1 })
    .lean();

  return res.status(200).json(
    new ApiResponse(200, tickets, "Support tickets fetched successfully")
  );
});
