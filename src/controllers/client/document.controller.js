import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import Document from "../../models/document.model.js";
import ApiError from "../../utils/ApiError.js";
import ApiResponse from "../../utils/ApiResponse.js";
import asyncHandler from "../../utils/asyncHandler.js";

/**
 * GET /api/client/documents
 * query: status?, serviceMatter?
 */
export const listMyDocuments = asyncHandler(async (req, res) => {
  const { status, serviceMatter } = req.query;

  const query = { client: req.user._id };

  if (status) {
    query.status = status;
  }

  if (serviceMatter) {
    query.serviceMatter = serviceMatter;
  }

  const documents = await Document.find(query)
    .populate("serviceMatter", "serviceSnapshot")
    .sort({ uploadedAt: -1 })
    .lean();

  return res.status(200).json(
    new ApiResponse(200, documents, "Documents fetched successfully")
  );
});

/**
 * POST /api/client/documents
 * multipart: file, serviceMatter?
 */
export const uploadDocument = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new ApiError(400, "A file is required");
  }

  const { serviceMatter } = req.body;

  if (serviceMatter && !mongoose.Types.ObjectId.isValid(serviceMatter)) {
    throw new ApiError(400, "Invalid serviceMatter ID");
  }

  const document = await Document.create({
    client: req.user._id,
    serviceMatter: serviceMatter || null,
    fileName: req.file.originalname,
    fileUrl: `/uploads/documents/${req.file.filename}`,
    mimeType: req.file.mimetype,
    sizeBytes: req.file.size,
    status: "uploaded",
  });

  return res.status(201).json(
    new ApiResponse(201, document, "Document uploaded successfully")
  );
});

/**
 * DELETE /api/client/documents/:id
 */
export const deleteMyDocument = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError(400, "Invalid document ID");
  }

  const document = await Document.findOne({ _id: id, client: req.user._id });

  if (!document) {
    throw new ApiError(404, "Document not found");
  }

  if (document.status === "verified") {
    throw new ApiError(400, "Verified documents cannot be deleted");
  }

  const absolutePath = path.resolve("." + document.fileUrl);

  fs.unlink(absolutePath, () => {});

  await document.deleteOne();

  return res.status(200).json(
    new ApiResponse(200, null, "Document deleted successfully")
  );
});

/**
 * GET /api/client/documents/stats
 */
export const getMyDocumentStats = asyncHandler(async (req, res) => {
  const clientId = req.user._id;

  const [total, verified, inReview, actionNeeded] = await Promise.all([
    Document.countDocuments({ client: clientId }),
    Document.countDocuments({ client: clientId, status: "verified" }),
    Document.countDocuments({ client: clientId, status: "in_review" }),
    Document.countDocuments({ client: clientId, status: "rejected" }),
  ]);

  return res.status(200).json(
    new ApiResponse(200, { total, verified, inReview, actionNeeded }, "Document stats fetched successfully")
  );
});
