import mongoose from "mongoose";
import Service from "../../models/service.model.js";
import ApiError from "../../utils/ApiError.js";
import ApiResponse from "../../utils/ApiResponse.js";
import asyncHandler from "../../utils/asyncHandler.js";

/**
 * GET /api/admin/services
 * query: category?, page, limit
 */
export const listServicesAdmin = asyncHandler(async (req, res) => {
  const { category, page = 1, limit = 20 } = req.query;

  const query = {};

  if (category) {
    query.category = category;
  }

  const pageNumber = Math.max(Number(page), 1);
  const limitNumber = Math.min(Math.max(Number(limit), 1), 100);
  const skip = (pageNumber - 1) * limitNumber;

  const [items, total] = await Promise.all([
    Service.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNumber)
      .lean(),

    Service.countDocuments(query),
  ]);

  return res.status(200).json(
    new ApiResponse(200, { items, total, page: pageNumber, limit: limitNumber }, "Services fetched successfully")
  );
});

/**
 * POST /api/admin/services
 */
export const createServiceAdmin = asyncHandler(async (req, res) => {
  try {
    const service = await Service.create(req.body);

    return res.status(201).json(new ApiResponse(201, service, "Service created successfully"));
  } catch (error) {
    if (error.code === 11000) {
      throw new ApiError(409, "A service with this slug already exists");
    }

    throw error;
  }
});

/**
 * PATCH /api/admin/services/:id
 */
export const updateServiceAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError(400, "Invalid service ID");
  }

  try {
    const service = await Service.findByIdAndUpdate(id, req.body, {
      new: true,
      runValidators: true,
    });

    if (!service) {
      throw new ApiError(404, "Service not found");
    }

    return res.status(200).json(new ApiResponse(200, service, "Service updated successfully"));
  } catch (error) {
    if (error.code === 11000) {
      throw new ApiError(409, "A service with this slug already exists");
    }

    throw error;
  }
});

/**
 * PATCH /api/admin/services/:id/publish
 * body: { isActive }
 */
export const publishServiceAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { isActive } = req.body;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError(400, "Invalid service ID");
  }

  if (typeof isActive !== "boolean") {
    throw new ApiError(400, "isActive must be a boolean");
  }

  const service = await Service.findByIdAndUpdate(id, { isActive }, { new: true });

  if (!service) {
    throw new ApiError(404, "Service not found");
  }

  return res.status(200).json(
    new ApiResponse(200, service, isActive ? "Service published successfully" : "Service unpublished successfully")
  );
});

/**
 * GET /api/admin/services/stats
 */
export const getServiceStatsAdmin = asyncHandler(async (req, res) => {
  const [totalPages, published, categories] = await Promise.all([
    Service.countDocuments({}),
    Service.countDocuments({ isActive: true }),
    Service.distinct("categorySlug"),
  ]);

  return res.status(200).json(
    new ApiResponse(
      200,
      { totalPages, categories: categories.length, published, brokenLinks: 0 },
      "Service stats fetched successfully"
    )
  );
});
