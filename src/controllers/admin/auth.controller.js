import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

import { User } from "../../models/user.model.js";
import ApiError from "../../utils/ApiError.js";
import ApiResponse from "../../utils/ApiResponse.js";
import asyncHandler from "../../utils/asyncHandler.js";
import { generateTokens } from "../../utils/generateToken.js";

const ADMIN_ROLES = ["admin", "super_admin"];

const cookieOptions = (maxAge) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  maxAge,
});

export const adminLogin = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    throw new ApiError(400, "Email and password are required");
  }

  const admin = await User.findOne({
    email: email.toLowerCase().trim(),
    role: { $in: ADMIN_ROLES },
    isDeleted: false,
  });

  if (!admin || !admin.password) {
    throw new ApiError(401, "Invalid email or password");
  }

  const isPasswordValid = await bcrypt.compare(password, admin.password);

  if (!isPasswordValid) {
    throw new ApiError(401, "Invalid email or password");
  }

  if (!admin.isActive) {
    throw new ApiError(403, "This admin account has been deactivated");
  }

  const { accessToken, refreshToken } = generateTokens(admin._id);

  admin.refreshToken = refreshToken;
  admin.lastLoginAt = new Date();

  await admin.save({ validateBeforeSave: false });

  res.cookie("accessToken", accessToken, cookieOptions(15 * 60 * 1000));
  res.cookie("refreshToken", refreshToken, cookieOptions(7 * 24 * 60 * 60 * 1000));

  const safeAdmin = await User.findById(admin._id).select(
    "-password -refreshToken -otp -otpExpiresAt"
  );

  return res.status(200).json(
    new ApiResponse(200, { admin: safeAdmin, accessToken, refreshToken }, "Login successful")
  );
});

export const adminLogout = asyncHandler(async (req, res) => {
  await User.findByIdAndUpdate(req.user._id, { $set: { refreshToken: null } });

  res.clearCookie("accessToken");
  res.clearCookie("refreshToken");

  return res.status(200).json(new ApiResponse(200, null, "Logged out successfully"));
});

export const adminRefreshToken = asyncHandler(async (req, res) => {
  const incomingRefreshToken = req.cookies?.refreshToken || req.body?.refreshToken;

  if (!incomingRefreshToken) {
    throw new ApiError(401, "Refresh token is required");
  }

  try {
    const decodedToken = jwt.verify(incomingRefreshToken, process.env.REFRESH_TOKEN_SECRET);

    const admin = await User.findById(decodedToken?._id);

    if (!admin || !ADMIN_ROLES.includes(admin.role)) {
      throw new ApiError(401, "Invalid refresh token");
    }

    if (admin.refreshToken !== incomingRefreshToken) {
      throw new ApiError(401, "Refresh token is expired or invalid");
    }

    const { accessToken, refreshToken } = generateTokens(admin._id);

    admin.refreshToken = refreshToken;

    await admin.save({ validateBeforeSave: false });

    res.cookie("accessToken", accessToken, cookieOptions(15 * 60 * 1000));
    res.cookie("refreshToken", refreshToken, cookieOptions(7 * 24 * 60 * 60 * 1000));

    return res.status(200).json(
      new ApiResponse(200, { accessToken, refreshToken }, "Access token refreshed successfully")
    );
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    throw new ApiError(401, "Invalid or expired refresh token");
  }
});

export const getAdminMe = asyncHandler(async (req, res) => {
  return res.status(200).json(
    new ApiResponse(200, req.user, "Admin profile fetched successfully")
  );
});
