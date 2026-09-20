import bcrypt from "bcryptjs";

import { User } from "../models/user.model.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";

export const updateProfile = asyncHandler(async (req, res) => {
  const { name, phone, profileImage } = req.body;

  const updateData = {};

  if (name !== undefined) {
    updateData.name = name;
  }

  if (phone !== undefined) {
    updateData.phone = phone;
  }

  if (profileImage !== undefined) {
    updateData.profileImage = profileImage;
  }

  if (Object.keys(updateData).length === 0) {
    throw new ApiError(400, "No valid fields provided for update");
  }

  const updatedUser = await User.findByIdAndUpdate(
    req.user._id,
    {
      $set: updateData,
    },
    {
      new: true,
      runValidators: true,
    }
  ).select("-password -refreshToken");

  if (!updatedUser) {
    throw new ApiError(404, "User not found");
  }

  return res.status(200).json(
    new ApiResponse(
      200,
      updatedUser,
      "Profile updated successfully"
    )
  );
});

export const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    throw new ApiError(
      400,
      "Current password and new password are required"
    );
  }

  if (newPassword.length < 6) {
    throw new ApiError(
      400,
      "New password must be at least 6 characters"
    );
  }

  const user = await User.findById(req.user._id);

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  const isPasswordCorrect = await bcrypt.compare(
    currentPassword,
    user.password
  );

  if (!isPasswordCorrect) {
    throw new ApiError(400, "Current password is incorrect");
  }

  user.password = await bcrypt.hash(newPassword, 12);

  // Invalidate existing refresh token
  user.refreshToken = null;

  await user.save();

  res.clearCookie("accessToken");
  res.clearCookie("refreshToken");

  return res.status(200).json(
    new ApiResponse(
      200,
      null,
      "Password changed successfully. Please login again."
    )
  );
});

export const deleteAccount = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  user.isDeleted = true;
  user.deletedAt = new Date();
  user.refreshToken = null;

  await user.save({ validateBeforeSave: false });

  res.clearCookie("accessToken");
  res.clearCookie("refreshToken");

  return res.status(200).json(
    new ApiResponse(
      200,
      null,
      "Account deleted successfully"
    )
  );
});