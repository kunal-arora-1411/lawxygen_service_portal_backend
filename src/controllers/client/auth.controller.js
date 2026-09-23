// Login and Register

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

import { User } from "../../models/user.model.js";
import ApiError from "../../utils/ApiError.js";
import ApiResponse from "../../utils/ApiResponse.js";
import asyncHandler from "../../utils/asyncHandler.js";

import {
  generateAccessToken,
  generateRefreshToken,
  generateTokens,
} from "../../utils/generateToken.js";
import {
  sendWelcomeEmail,
  sendPasswordResetOTP,
} from "../../services/email.service.js";

const cookieOptions = (maxAge) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  maxAge,
});

const setAuthCookies = (res, accessToken, refreshToken) => {
  res.cookie("accessToken", accessToken, cookieOptions(15 * 60 * 1000));
  res.cookie(
    "refreshToken",
    refreshToken,
    cookieOptions(7 * 24 * 60 * 60 * 1000),
  );
};

export const testEmail = async (req, res) => {
  try {
    await sendWelcomeEmail("test@example.com", "Bhumi");

    return res.status(200).json({
      success: true,
      message: "Test email sent",
    });
  } catch (error) {
    console.error("EMAIL ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to send email",
      error: error.message,
    });
  }
};

export const emailAuth = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    throw new ApiError(400, "Email and password are required");
  }

  const normalizedEmail = email.toLowerCase().trim();

  let user = await User.findOne({
    email: normalizedEmail,
    isDeleted: false,
  });

  // =========================
  // EXISTING USER → LOGIN
  // =========================

  if (user) {
    // User may have originally registered using Google/Apple/etc.
    if (!user.password) {
      throw new ApiError(
        400,
        "This email is already registered using another login method",
      );
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      throw new ApiError(401, "Invalid email or password");
    }

    const { accessToken, refreshToken } = generateTokens(user._id);

    user.refreshToken = refreshToken;
    user.lastLoginAt = new Date();

    await user.save({
      validateBeforeSave: false,
    });

    const loggedInUser = await User.findById(user._id).select(
      "-password -refreshToken -otp -otpExpiresAt",
    );

    setAuthCookies(res, accessToken, refreshToken);

    return res.status(200).json(
      new ApiResponse(
        200,
        {
          user: loggedInUser,
          accessToken,
          refreshToken,
          isNewUser: false,
        },
        "Login successful",
      ),
    );
  }

  // =========================
  // NEW USER → REGISTER
  // =========================

  const hashedPassword = await bcrypt.hash(password, 12);

  user = await User.create({
    email: normalizedEmail,
    password: hashedPassword,
    isVerified: true,
    authProviders: [
      {
        provider: "email",
        providerId: normalizedEmail,
      },
    ],
  });

  try {
    await sendWelcomeEmail(user.email, user.name);
  } catch (error) {
    console.error("Welcome email failed:", error);
  }

  const { accessToken, refreshToken } = generateTokens(user._id);

  user.refreshToken = refreshToken;
  user.lastLoginAt = new Date();

  await user.save({
    validateBeforeSave: false,
  });

  const createdUser = await User.findById(user._id).select(
    "-password -refreshToken -otp -otpExpiresAt",
  );

  setAuthCookies(res, accessToken, refreshToken);

  return res.status(201).json(
    new ApiResponse(
      201,
      {
        user: createdUser,
        accessToken,
        refreshToken,
        isNewUser: true,
      },
      "Account created successfully",
    ),
  );
});

export const sendPhoneOtp = asyncHandler(async (req, res) => {
  const { phone } = req.body;

  if (!phone) {
    throw new ApiError(400, "Phone number is required");
  }

  const normalizedPhone = phone.trim();

  let user = await User.findOne({
    phone: normalizedPhone,
    isDeleted: false,
  });

  // Generate 6 digit OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();

  const otpExpiresAt = new Date(Date.now() + 5 * 60 * 1000);

  // Existing user
  if (user) {
    user.otp = otp;
    user.otpExpiresAt = otpExpiresAt;

    await user.save({
      validateBeforeSave: false,
    });
  }

  // New user
  else {
    user = await User.create({
      phone: normalizedPhone,
      otp,
      otpExpiresAt,
      authProviders: [
        {
          provider: "phone",
          providerId: normalizedPhone,
        },
      ],
    });
  }

  // TODO:
  // Send OTP using MSG91 here

  return res
    .status(200)
    .json(new ApiResponse(200, null, "OTP sent successfully"));
});

export const verifyPhoneOtp = asyncHandler(async (req, res) => {
  const { phone, otp } = req.body;

  if (!phone || !otp) {
    throw new ApiError(400, "Phone number and OTP are required");
  }

  const normalizedPhone = phone.trim();

  const user = await User.findOne({
    phone: normalizedPhone,
    isDeleted: false,
  });

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  if (!user.otp || !user.otpExpiresAt) {
    throw new ApiError(400, "OTP not requested");
  }

  if (user.otpExpiresAt < new Date()) {
    throw new ApiError(400, "OTP has expired");
  }

  if (user.otp !== otp) {
    throw new ApiError(400, "Invalid OTP");
  }

  // OTP verified
  user.otp = null;
  user.otpExpiresAt = null;
  user.isVerified = true;
  user.lastLoginAt = new Date();

  const { accessToken, refreshToken } = generateTokens(user._id);

  user.refreshToken = refreshToken;

  await user.save({
    validateBeforeSave: false,
  });

  const loggedInUser = await User.findById(user._id).select(
    "-password -refreshToken -otp -otpExpiresAt",
  );

  setAuthCookies(res, accessToken, refreshToken);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        user: loggedInUser,
        accessToken,
        refreshToken,
        isNewUser: !user.name,
      },
      "Authentication successful",
    ),
  );
});

export const getCurrentUser = asyncHandler(async (req, res) => {
  return res
    .status(200)
    .json(new ApiResponse(200, req.user, "User fetched successfully"));
});

export const refreshAccessToken = asyncHandler(async (req, res) => {
  const incomingRefreshToken =
    req.cookies?.refreshToken || req.body?.refreshToken;

  if (!incomingRefreshToken) {
    throw new ApiError(401, "Refresh token is required");
  }

  try {
    const decodedToken = jwt.verify(
      incomingRefreshToken,
      process.env.REFRESH_TOKEN_SECRET,
    );

    const { accessToken, refreshToken } = generateTokens(decodedToken?._id);

    // Atomic check-and-rotate — see the identical comment in
    // admin/auth.controller.js. Prevents concurrent refresh calls (e.g.
    // several widgets 401ing at once) from all "succeeding" with different,
    // conflicting token pairs where only one actually matches the DB.
    const user = await User.findOneAndUpdate(
      {
        _id: decodedToken?._id,
        refreshToken: incomingRefreshToken,
        isDeleted: false,
      },
      { $set: { refreshToken } },
      { new: true }
    );

    if (!user) {
      throw new ApiError(401, "Refresh token is expired or invalid");
    }

    setAuthCookies(res, accessToken, refreshToken);

    return res.status(200).json(
      new ApiResponse(
        200,
        {
          accessToken,
          refreshToken,
        },
        "Access token refreshed successfully",
      ),
    );
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    throw new ApiError(401, "Invalid or expired refresh token");
  }
});

export const logoutUser = asyncHandler(async (req, res) => {
  await User.findByIdAndUpdate(req.user._id, {
    $set: {
      refreshToken: null,
    },
  });

  res.clearCookie("accessToken");
  res.clearCookie("refreshToken");

  return res
    .status(200)
    .json(new ApiResponse(200, null, "User logged out successfully"));
});

export const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;

  if (!email) {
    throw new ApiError(400, "Email is required");
  }

  const user = await User.findOne({
    email: email.toLowerCase().trim(),
    isDeleted: false,
  });

  if (!user) {
    throw new ApiError(404, "No account found with this email");
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

  user.otp = otp;
  user.otpExpiresAt = otpExpiresAt;

  await user.save({ validateBeforeSave: false });

  await sendPasswordResetOTP(user.email, otp);

  return res
    .status(200)
    .json(new ApiResponse(200, null, "OTP sent to your email"));
});

export const verifyResetOtp = asyncHandler(async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    throw new ApiError(400, "Email and OTP are required");
  }

  const user = await User.findOne({
    email: email.toLowerCase().trim(),
    isDeleted: false,
  });

  if (!user) {
    throw new ApiError(404, "No account found with this email");
  }

  if (!user.otp || !user.otpExpiresAt) {
    throw new ApiError(400, "OTP not requested");
  }

  if (user.otpExpiresAt < new Date()) {
    throw new ApiError(400, "OTP has expired");
  }

  if (user.otp !== otp) {
    throw new ApiError(400, "Invalid OTP");
  }

  return res
    .status(200)
    .json(new ApiResponse(200, null, "OTP verified successfully"));
});

export const resetPassword = asyncHandler(async (req, res) => {
  const { email, otp, newPassword } = req.body;

  if (!email || !otp || !newPassword) {
    throw new ApiError(400, "Email, OTP and new password are required");
  }

  if (newPassword.length < 8) {
    throw new ApiError(400, "Password must be at least 8 characters long");
  }

  const user = await User.findOne({
    email: email.toLowerCase().trim(),
    isDeleted: false,
  });

  if (!user) {
    throw new ApiError(404, "No account found with this email");
  }

  if (!user.otp || !user.otpExpiresAt) {
    throw new ApiError(400, "OTP not requested");
  }

  if (user.otpExpiresAt < new Date()) {
    throw new ApiError(400, "OTP has expired");
  }

  if (user.otp !== otp) {
    throw new ApiError(400, "Invalid OTP");
  }

  user.password = await bcrypt.hash(newPassword, 12);
  user.otp = null;
  user.otpExpiresAt = null;
  user.refreshToken = null;

  await user.save({ validateBeforeSave: false });

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        null,
        "Password reset successfully. Please log in with your new password."
      )
    );
});
