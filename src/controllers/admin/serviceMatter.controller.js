import mongoose from "mongoose";
import ServiceMatter from "../../models/serviceMatter.model.js";
import { User } from "../../models/user.model.js";
import ApiError from "../../utils/ApiError.js";
import ApiResponse from "../../utils/ApiResponse.js";
import asyncHandler from "../../utils/asyncHandler.js";

/**
 * GET /api/admin/service-matters
 * query: status?, unassigned?, page, limit
 */
export const listServiceMatters = asyncHandler(async (req, res) => {
  const { status, unassigned, page = 1, limit = 20 } = req.query;

  const query = {};

  if (status) {
    query.status = status;
  }

  if (unassigned === "true") {
    query.professional = null;
  }

  const pageNumber = Math.max(Number(page), 1);
  const limitNumber = Math.min(Math.max(Number(limit), 1), 100);
  const skip = (pageNumber - 1) * limitNumber;

  const [items, total] = await Promise.all([
    ServiceMatter.find(query)
      .populate("client", "name email phone")
      .populate("professional", "name email phone")
      .populate("assignedBy", "name email")
      .populate("service", "title slug category categorySlug accent summary price")
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limitNumber)
      .lean(),

    ServiceMatter.countDocuments(query),
  ]);

  return res.status(200).json(
    new ApiResponse(
      200,
      { items, total, page: pageNumber, limit: limitNumber },
      "Service requests fetched successfully"
    )
  );
});

/**
 * GET /api/admin/service-matters/:id
 */
export const getServiceMatterById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError(400, "Invalid matter ID");
  }

  const matter = await ServiceMatter.findById(id)
    .populate("client", "name email phone")
    .populate("professional", "name email phone")
    .populate("assignedBy", "name email")
    .populate("service", "title slug category categorySlug accent summary price process")
    .lean();

  if (!matter) {
    throw new ApiError(404, "Service matter not found");
  }

  return res.status(200).json(
    new ApiResponse(200, matter, "Service matter fetched successfully")
  );
});

/**
 * PATCH /api/admin/service-matters/:id
 * body: { status?, professional?, actionRequired?, actionMessage? }
 */
export const updateServiceMatter = asyncHandler(async (req, res) => {
  const adminId = req.user._id;
  const { id } = req.params;
  const { status, professional, actionRequired, actionMessage } = req.body;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError(400, "Invalid matter ID");
  }

  const matter = await ServiceMatter.findById(id);

  if (!matter) {
    throw new ApiError(404, "Service matter not found");
  }

  if (professional !== undefined) {
    if (professional === null) {
      matter.professional = null;
    } else {
      if (!mongoose.Types.ObjectId.isValid(professional)) {
        throw new ApiError(400, "Invalid professional ID");
      }

      const professionalUser = await User.findOne({
        _id: professional,
        role: "professional",
        isActive: true,
      });

      if (!professionalUser) {
        throw new ApiError(404, "Professional not found");
      }

      matter.professional = professionalUser._id;
      matter.assignedBy = adminId;
      matter.assignedAt = new Date();

      if (matter.status === "PAID" || matter.status === "PAYMENT_PENDING") {
        matter.status = "ASSIGNED";
      }
    }
  }

  if (status !== undefined) {
    const allowedStatuses = [
      "PAYMENT_PENDING",
      "PAID",
      "ASSIGNED",
      "IN_PROGRESS",
      "ACTION_REQUIRED",
      "UNDER_REVIEW",
      "COMPLETED",
      "CANCELLED",
    ];

    if (!allowedStatuses.includes(status)) {
      throw new ApiError(400, "Invalid service matter status");
    }

    matter.status = status;

    if (status === "IN_PROGRESS" && !matter.startedAt) {
      matter.startedAt = new Date();
    }

    if (status === "COMPLETED") {
      matter.progress = 100;
      matter.completedAt = new Date();
    }
  }

  if (actionRequired !== undefined) {
    matter.actionRequired = actionRequired;

    if (actionRequired) {
      matter.status = "ACTION_REQUIRED";
    }
  }

  if (actionMessage !== undefined) {
    matter.actionMessage = actionMessage;
  }

  await matter.save();

  const updatedMatter = await ServiceMatter.findById(matter._id)
    .populate("client", "name email phone")
    .populate("professional", "name email phone")
    .populate("assignedBy", "name email")
    .populate("service", "title slug category categorySlug");

  return res.status(200).json(
    new ApiResponse(200, updatedMatter, "Service matter updated successfully")
  );
});

/**
 * GET /api/admin/service-matters/stats
 */
export const getServiceMatterStats = asyncHandler(async (req, res) => {
  const activeStatuses = ["PAID", "ASSIGNED", "IN_PROGRESS", "ACTION_REQUIRED", "UNDER_REVIEW"];

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);

  const [active, unassigned, dueToday, completedCount, totalNonCancelled] = await Promise.all([
    ServiceMatter.countDocuments({ status: { $in: activeStatuses } }),
    ServiceMatter.countDocuments({ professional: null, status: { $in: activeStatuses } }),
    ServiceMatter.countDocuments({
      status: { $in: activeStatuses },
      updatedAt: { $gte: startOfToday, $lte: endOfToday },
    }),
    ServiceMatter.countDocuments({ status: "COMPLETED" }),
    ServiceMatter.countDocuments({ status: { $ne: "CANCELLED" } }),
  ]);

  const withinSlaPercent =
    totalNonCancelled > 0 ? Math.round((completedCount / totalNonCancelled) * 100) : 0;

  return res.status(200).json(
    new ApiResponse(
      200,
      { active, unassigned, dueToday, withinSlaPercent },
      "Service request stats fetched successfully"
    )
  );
});
