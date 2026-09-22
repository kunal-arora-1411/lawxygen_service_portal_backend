import mongoose from "mongoose";
import SupportTicket from "../../models/supportTicket.model.js";
import ApiError from "../../utils/ApiError.js";
import ApiResponse from "../../utils/ApiResponse.js";
import asyncHandler from "../../utils/asyncHandler.js";

/**
 * GET /api/admin/support/tickets
 * query: status?, page, limit
 */
export const listSupportTicketsAdmin = asyncHandler(async (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;

  const query = {};

  if (status) {
    query.status = status;
  }

  const pageNumber = Math.max(Number(page), 1);
  const limitNumber = Math.min(Math.max(Number(limit), 1), 100);
  const skip = (pageNumber - 1) * limitNumber;

  const [items, total] = await Promise.all([
    SupportTicket.find(query)
      .populate("client", "name email")
      .populate("serviceMatter", "serviceSnapshot")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNumber)
      .lean(),

    SupportTicket.countDocuments(query),
  ]);

  return res.status(200).json(
    new ApiResponse(200, { items, total, page: pageNumber, limit: limitNumber }, "Support tickets fetched successfully")
  );
});

/**
 * PATCH /api/admin/support/tickets/:id
 * body: { status }
 */
export const updateSupportTicketAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError(400, "Invalid ticket ID");
  }

  const allowedStatuses = ["waiting", "in_progress", "resolved"];

  if (!allowedStatuses.includes(status)) {
    throw new ApiError(400, "Invalid ticket status");
  }

  const ticket = await SupportTicket.findById(id);

  if (!ticket) {
    throw new ApiError(404, "Support ticket not found");
  }

  ticket.status = status;

  if (status === "resolved") {
    ticket.resolvedAt = new Date();
  }

  await ticket.save();

  return res.status(200).json(
    new ApiResponse(200, ticket, "Support ticket updated successfully")
  );
});

/**
 * GET /api/admin/support/stats
 */
export const getSupportStatsAdmin = asyncHandler(async (req, res) => {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [waiting, inProgress, resolvedToday, resolvedTickets] = await Promise.all([
    SupportTicket.countDocuments({ status: "waiting" }),
    SupportTicket.countDocuments({ status: "in_progress" }),
    SupportTicket.countDocuments({ status: "resolved", resolvedAt: { $gte: startOfToday } }),
    SupportTicket.find({ status: "resolved", resolvedAt: { $ne: null } })
      .select("waitStartedAt resolvedAt")
      .lean(),
  ]);

  const avgResponseMinutes =
    resolvedTickets.length > 0
      ? Math.round(
          resolvedTickets.reduce(
            (sum, t) => sum + (new Date(t.resolvedAt) - new Date(t.waitStartedAt)) / 60000,
            0
          ) / resolvedTickets.length
        )
      : 0;

  return res.status(200).json(
    new ApiResponse(
      200,
      { waiting, inProgress, resolvedToday, avgResponseMinutes },
      "Support stats fetched successfully"
    )
  );
});
