import mongoose from "mongoose";
import ComplianceItem from "../../models/compliance.model.js";
import { User } from "../../models/user.model.js";
import ApiError from "../../utils/ApiError.js";
import ApiResponse from "../../utils/ApiResponse.js";
import asyncHandler from "../../utils/asyncHandler.js";

/**
 * POST /api/admin/compliance
 * body: { client, serviceMatter?, title, description, dueAt }
 */
export const createComplianceAdmin = asyncHandler(async (req, res) => {
  const { client, serviceMatter, title, description, dueAt } = req.body;

  if (!client || !mongoose.Types.ObjectId.isValid(client)) {
    throw new ApiError(400, "A valid client ID is required");
  }

  if (!title?.trim()) {
    throw new ApiError(400, "Title is required");
  }

  if (!dueAt) {
    throw new ApiError(400, "dueAt is required");
  }

  const clientUser = await User.findOne({ _id: client, role: "user" });

  if (!clientUser) {
    throw new ApiError(404, "Client not found");
  }

  const item = await ComplianceItem.create({
    client,
    serviceMatter: serviceMatter || null,
    title: title.trim(),
    description: description || "",
    dueAt: new Date(dueAt),
    status: "upcoming",
  });

  return res.status(201).json(
    new ApiResponse(201, item, "Compliance deadline created successfully")
  );
});

/**
 * PATCH /api/admin/compliance/:id
 * body: { status?, dueAt? }
 */
export const updateComplianceAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, dueAt } = req.body;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError(400, "Invalid compliance item ID");
  }

  const item = await ComplianceItem.findById(id);

  if (!item) {
    throw new ApiError(404, "Compliance item not found");
  }

  if (status !== undefined) {
    const allowedStatuses = ["upcoming", "due_soon", "completed", "overdue"];

    if (!allowedStatuses.includes(status)) {
      throw new ApiError(400, "Invalid status");
    }

    item.status = status;

    if (status === "completed") {
      item.completedAt = new Date();
    }
  }

  if (dueAt !== undefined) {
    item.dueAt = new Date(dueAt);
  }

  await item.save();

  return res.status(200).json(
    new ApiResponse(200, item, "Compliance item updated successfully")
  );
});

/**
 * GET /api/admin/compliance
 * query: client?, status?, page, limit
 */
export const listComplianceAdmin = asyncHandler(async (req, res) => {
  const { client, status, page = 1, limit = 20 } = req.query;

  const query = {};

  if (client) {
    query.client = client;
  }

  if (status) {
    query.status = status;
  }

  const pageNumber = Math.max(Number(page), 1);
  const limitNumber = Math.min(Math.max(Number(limit), 1), 100);
  const skip = (pageNumber - 1) * limitNumber;

  const [items, total] = await Promise.all([
    ComplianceItem.find(query)
      .populate("client", "name email")
      .populate("serviceMatter", "serviceSnapshot")
      .sort({ dueAt: 1 })
      .skip(skip)
      .limit(limitNumber)
      .lean(),

    ComplianceItem.countDocuments(query),
  ]);

  return res.status(200).json(
    new ApiResponse(200, { items, total, page: pageNumber, limit: limitNumber }, "Compliance items fetched successfully")
  );
});
