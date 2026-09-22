import mongoose from "mongoose";
import Document from "../../models/document.model.js";
import ApiError from "../../utils/ApiError.js";
import ApiResponse from "../../utils/ApiResponse.js";
import asyncHandler from "../../utils/asyncHandler.js";

/**
 * GET /api/admin/documents
 * query: status?, client?, page, limit
 */
export const listDocumentsAdmin = asyncHandler(async (req, res) => {
  const { status, client, page = 1, limit = 20 } = req.query;

  const query = {};

  if (status) {
    query.status = status;
  }

  if (client) {
    query.client = client;
  }

  const pageNumber = Math.max(Number(page), 1);
  const limitNumber = Math.min(Math.max(Number(limit), 1), 100);
  const skip = (pageNumber - 1) * limitNumber;

  const [items, total] = await Promise.all([
    Document.find(query)
      .populate("client", "name email")
      .populate("serviceMatter", "serviceSnapshot")
      .sort({ uploadedAt: -1 })
      .skip(skip)
      .limit(limitNumber)
      .lean(),

    Document.countDocuments(query),
  ]);

  return res.status(200).json(
    new ApiResponse(200, { items, total, page: pageNumber, limit: limitNumber }, "Documents fetched successfully")
  );
});

/**
 * PATCH /api/admin/documents/:id
 * body: { status, reviewNote? }
 */
export const updateDocumentStatusAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, reviewNote } = req.body;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError(400, "Invalid document ID");
  }

  const allowedStatuses = ["uploaded", "in_review", "verified", "rejected"];

  if (!allowedStatuses.includes(status)) {
    throw new ApiError(400, "Invalid document status");
  }

  const document = await Document.findById(id);

  if (!document) {
    throw new ApiError(404, "Document not found");
  }

  document.status = status;
  document.reviewNote = reviewNote ?? document.reviewNote;

  if (status === "verified" || status === "rejected") {
    document.reviewedAt = new Date();
  }

  await document.save();

  return res.status(200).json(
    new ApiResponse(200, document, "Document status updated successfully")
  );
});
