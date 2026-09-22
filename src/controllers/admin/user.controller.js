import mongoose from "mongoose";
import { User } from "../../models/user.model.js";
import ServiceMatter from "../../models/serviceMatter.model.js";
import ApiError from "../../utils/ApiError.js";
import ApiResponse from "../../utils/ApiResponse.js";
import asyncHandler from "../../utils/asyncHandler.js";

const ACTIVE_MATTER_STATUSES = ["PAID", "ASSIGNED", "IN_PROGRESS", "ACTION_REQUIRED", "UNDER_REVIEW"];

/**
 * GET /api/admin/users
 * query: search?, page, limit
 */
export const listUsers = asyncHandler(async (req, res) => {
  const { search, page = 1, limit = 20 } = req.query;

  const query = { role: "user", isDeleted: false };

  if (search) {
    query.$or = [
      { name: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
      { phone: { $regex: search, $options: "i" } },
    ];
  }

  const pageNumber = Math.max(Number(page), 1);
  const limitNumber = Math.min(Math.max(Number(limit), 1), 100);
  const skip = (pageNumber - 1) * limitNumber;

  const [users, total] = await Promise.all([
    User.find(query)
      .select("name email phone location isVerified isActive createdAt")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNumber)
      .lean(),

    User.countDocuments(query),
  ]);

  const activeMatterCounts = await ServiceMatter.aggregate([
    {
      $match: {
        client: { $in: users.map((user) => user._id) },
        status: { $in: ACTIVE_MATTER_STATUSES },
      },
    },
    { $group: { _id: "$client", count: { $sum: 1 } } },
  ]);

  const countByClient = new Map(
    activeMatterCounts.map((entry) => [entry._id.toString(), entry.count])
  );

  const items = users.map((user) => ({
    _id: user._id,
    name: user.name,
    location: user.location,
    activeMattersCount: countByClient.get(user._id.toString()) || 0,
    joinedAt: user.createdAt,
    status: user.isActive ? "active" : "inactive",
    verified: user.isVerified,
  }));

  return res.status(200).json(
    new ApiResponse(200, { items, total, page: pageNumber, limit: limitNumber }, "Users fetched successfully")
  );
});

/**
 * GET /api/admin/users/all
 * query: search?, role?, page, limit
 *
 * Every User document (clients + professionals), excluding admin/super_admin
 * accounts (i.e. excludes the seeded admin and any other staff logins).
 */
export const listAllUsers = asyncHandler(async (req, res) => {
  const { search, role, page = 1, limit = 20 } = req.query;

  const query = { role: { $nin: ["admin", "super_admin"] }, isDeleted: false };

  if (role) {
    if (!["user", "professional"].includes(role)) {
      throw new ApiError(400, "Invalid role filter");
    }

    query.role = role;
  }

  if (search) {
    query.$or = [
      { name: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
      { phone: { $regex: search, $options: "i" } },
    ];
  }

  const pageNumber = Math.max(Number(page), 1);
  const limitNumber = Math.min(Math.max(Number(limit), 1), 100);
  const skip = (pageNumber - 1) * limitNumber;

  const [items, total] = await Promise.all([
    User.find(query)
      .select("name email phone role location isVerified isActive professionalProfile createdAt")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNumber)
      .lean(),

    User.countDocuments(query),
  ]);

  return res.status(200).json(
    new ApiResponse(200, { items, total, page: pageNumber, limit: limitNumber }, "Users fetched successfully")
  );
});

/**
 * GET /api/admin/users/:id
 */
export const getUserById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError(400, "Invalid user ID");
  }

  const user = await User.findOne({ _id: id, role: "user" })
    .select("-password -refreshToken -otp -otpExpiresAt")
    .lean();

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  const [matters, matterCount] = await Promise.all([
    ServiceMatter.find({ client: id })
      .populate("service", "title slug category")
      .sort({ updatedAt: -1 })
      .limit(10)
      .lean(),
    ServiceMatter.countDocuments({ client: id }),
  ]);

  return res.status(200).json(
    new ApiResponse(
      200,
      { ...user, matters, matterCount },
      "User fetched successfully"
    )
  );
});

/**
 * GET /api/admin/users/stats
 */
export const getUserStats = asyncHandler(async (req, res) => {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const [registered, newThisMonth, activeMatters, verifiedCount] = await Promise.all([
    User.countDocuments({ role: "user", isDeleted: false }),
    User.countDocuments({ role: "user", isDeleted: false, createdAt: { $gte: startOfMonth } }),
    ServiceMatter.countDocuments({ status: { $in: ACTIVE_MATTER_STATUSES } }),
    User.countDocuments({ role: "user", isDeleted: false, isVerified: true }),
  ]);

  const verifiedPercent = registered > 0 ? Math.round((verifiedCount / registered) * 100) : 0;

  return res.status(200).json(
    new ApiResponse(
      200,
      { registered, newThisMonth, activeMatters, verifiedPercent },
      "User stats fetched successfully"
    )
  );
});
