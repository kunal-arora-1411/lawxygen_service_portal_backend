import mongoose from "mongoose";
import { User } from "../../models/user.model.js";
import ServiceMatter from "../../models/serviceMatter.model.js";
import ApiError from "../../utils/ApiError.js";
import ApiResponse from "../../utils/ApiResponse.js";
import asyncHandler from "../../utils/asyncHandler.js";

const ACTIVE_MATTER_STATUSES = ["ASSIGNED", "IN_PROGRESS", "ACTION_REQUIRED", "UNDER_REVIEW"];

const toProfessionalShape = (user, activeMattersCount = 0) => ({
  _id: user._id,
  name: user.name,
  role: user.professionalProfile?.title || "",
  specialties: user.professionalProfile?.specialties || [],
  languages: user.professionalProfile?.languages || [],
  availability: user.professionalProfile?.availability || "offline",
  activeMattersCount,
  createdAt: user.createdAt,
});

/**
 * GET /api/admin/professionals
 * query: availability?, page, limit
 */
export const listProfessionals = asyncHandler(async (req, res) => {
  const { availability, page = 1, limit = 20 } = req.query;

  const query = { role: "professional", isDeleted: false };

  if (availability) {
    query["professionalProfile.availability"] = availability;
  }

  const pageNumber = Math.max(Number(page), 1);
  const limitNumber = Math.min(Math.max(Number(limit), 1), 100);
  const skip = (pageNumber - 1) * limitNumber;

  const [users, total] = await Promise.all([
    User.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNumber).lean(),
    User.countDocuments(query),
  ]);

  const activeMatterCounts = await ServiceMatter.aggregate([
    {
      $match: {
        professional: { $in: users.map((user) => user._id) },
        status: { $in: ACTIVE_MATTER_STATUSES },
      },
    },
    { $group: { _id: "$professional", count: { $sum: 1 } } },
  ]);

  const countByProfessional = new Map(
    activeMatterCounts.map((entry) => [entry._id.toString(), entry.count])
  );

  const items = users.map((user) =>
    toProfessionalShape(user, countByProfessional.get(user._id.toString()) || 0)
  );

  return res.status(200).json(
    new ApiResponse(200, { items, total, page: pageNumber, limit: limitNumber }, "Professionals fetched successfully")
  );
});

/**
 * POST /api/admin/professionals
 * body: { name, role, specialties, languages, email?, phone? }
 */
export const createProfessional = asyncHandler(async (req, res) => {
  const { name, role, specialties = [], languages = [], email, phone } = req.body;

  if (!name?.trim()) {
    throw new ApiError(400, "Name is required");
  }

  const professional = await User.create({
    name: name.trim(),
    email: email ? email.toLowerCase().trim() : null,
    phone: phone ? phone.trim() : null,
    role: "professional",
    isVerified: true,
    professionalProfile: {
      title: role || "",
      specialties,
      languages,
      availability: "offline",
    },
  });

  return res.status(201).json(
    new ApiResponse(201, toProfessionalShape(professional), "Professional created successfully")
  );
});

/**
 * PATCH /api/admin/professionals/:id
 * body: { availability?, specialties?, languages? }
 */
export const updateProfessional = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { availability, specialties, languages, role } = req.body;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError(400, "Invalid professional ID");
  }

  const professional = await User.findOne({ _id: id, role: "professional" });

  if (!professional) {
    throw new ApiError(404, "Professional not found");
  }

  if (availability !== undefined) {
    professional.professionalProfile.availability = availability;
  }

  if (specialties !== undefined) {
    professional.professionalProfile.specialties = specialties;
  }

  if (languages !== undefined) {
    professional.professionalProfile.languages = languages;
  }

  if (role !== undefined) {
    professional.professionalProfile.title = role;
  }

  await professional.save();

  return res.status(200).json(
    new ApiResponse(200, toProfessionalShape(professional), "Professional updated successfully")
  );
});

/**
 * GET /api/admin/professionals/stats
 */
export const getProfessionalStats = asyncHandler(async (req, res) => {
  const [total, online, inCall, offline] = await Promise.all([
    User.countDocuments({ role: "professional", isDeleted: false }),
    User.countDocuments({ role: "professional", isDeleted: false, "professionalProfile.availability": "online" }),
    User.countDocuments({ role: "professional", isDeleted: false, "professionalProfile.availability": "in_call" }),
    User.countDocuments({ role: "professional", isDeleted: false, "professionalProfile.availability": "offline" }),
  ]);

  return res.status(200).json(
    new ApiResponse(200, { total, online, inCall, offline }, "Professional stats fetched successfully")
  );
});
