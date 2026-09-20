// Login and Register

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

import { User } from "../models/user.model.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";

import {
  generateAccessToken,
  generateRefreshToken,
  generateTokens
} from "../utils/generateToken.js";

export const emailAuth = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    throw new ApiError(
      400,
      "Email and password are required"
    );
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
        "This email is already registered using another login method"
      );
    }

    const isPasswordValid = await bcrypt.compare(
      password,
      user.password
    );

    if (!isPasswordValid) {
      throw new ApiError(
        401,
        "Invalid email or password"
      );
    }

    const { accessToken, refreshToken } =
      generateTokens(user._id);

    user.refreshToken = refreshToken;
    user.lastLoginAt = new Date();

    await user.save({
      validateBeforeSave: false,
    });

    const loggedInUser = await User.findById(user._id).select(
      "-password -refreshToken -otp -otpExpiresAt"
    );

    return res.status(200).json(
      new ApiResponse(
        200,
        {
          user: loggedInUser,
          accessToken,
          refreshToken,
          isNewUser: false,
        },
        "Login successful"
      )
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
        type: "email",
      },
    ],
  });

  const { accessToken, refreshToken } =
    generateTokens(user._id);

  user.refreshToken = refreshToken;
  user.lastLoginAt = new Date();

  await user.save({
    validateBeforeSave: false,
  });

  const createdUser = await User.findById(user._id).select(
    "-password -refreshToken -otp -otpExpiresAt"
  );

  return res.status(201).json(
    new ApiResponse(
      201,
      {
        user: createdUser,
        accessToken,
        refreshToken,
        isNewUser: true,
      },
      "Account created successfully"
    )
  );
});

export const sendPhoneOtp = asyncHandler(async (req, res) => {
  const { phone } = req.body;

  if (!phone) {
    throw new ApiError(
      400,
      "Phone number is required"
    );
  }

  const normalizedPhone = phone.trim();

  let user = await User.findOne({
    phone: normalizedPhone,
    isDeleted: false,
  });

  // Generate 6 digit OTP
  const otp = Math.floor(
    100000 + Math.random() * 900000
  ).toString();

  const otpExpiresAt = new Date(
    Date.now() + 5 * 60 * 1000
  );

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
          type: "phone",
        },
      ],
    });
  }

  // TODO:
  // Send OTP using MSG91 here

  return res.status(200).json(
    new ApiResponse(
      200,
      null,
      "OTP sent successfully"
    )
  );
});

export const verifyPhoneOtp = asyncHandler(async (req, res) => {
  const { phone, otp } = req.body;

  if (!phone || !otp) {
    throw new ApiError(
      400,
      "Phone number and OTP are required"
    );
  }

  const normalizedPhone = phone.trim();

  const user = await User.findOne({
    phone: normalizedPhone,
    isDeleted: false,
  });

  if (!user) {
    throw new ApiError(
      404,
      "User not found"
    );
  }

  if (!user.otp || !user.otpExpiresAt) {
    throw new ApiError(
      400,
      "OTP not requested"
    );
  }

  if (user.otpExpiresAt < new Date()) {
    throw new ApiError(
      400,
      "OTP has expired"
    );
  }

  if (user.otp !== otp) {
    throw new ApiError(
      400,
      "Invalid OTP"
    );
  }

  // OTP verified
  user.otp = null;
  user.otpExpiresAt = null;
  user.isVerified = true;
  user.lastLoginAt = new Date();

  const { accessToken, refreshToken } =
    generateTokens(user._id);

  user.refreshToken = refreshToken;

  await user.save({
    validateBeforeSave: false,
  });

  const loggedInUser = await User.findById(user._id).select(
    "-password -refreshToken -otp -otpExpiresAt"
  );

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        user: loggedInUser,
        accessToken,
        refreshToken,
        isNewUser: !user.name,
      },
      "Authentication successful"
    )
  );
});

export const getCurrentUser = asyncHandler(async (req, res) => {
  return res.status(200).json(
    new ApiResponse(
      200,
      req.user,
      "User fetched successfully"
    )
  );
});

export const refreshAccessToken = asyncHandler(async (req, res) => {
  const incomingRefreshToken =
    req.cookies?.refreshToken ||
    req.body?.refreshToken;

  if (!incomingRefreshToken) {
    throw new ApiError(401, "Refresh token is required");
  }

  try {
    const decodedToken = jwt.verify(
      incomingRefreshToken,
      process.env.REFRESH_TOKEN_SECRET
    );

    const user = await User.findById(decodedToken?._id);

    if (!user) {
      throw new ApiError(401, "Invalid refresh token");
    }

    if (user.isDeleted) {
      throw new ApiError(403, "User account is deleted");
    }

    if (user.refreshToken !== incomingRefreshToken) {
      throw new ApiError(401, "Refresh token is expired or invalid");
    }

    const { accessToken, refreshToken } =
      await generateTokens(user._id);

    user.refreshToken = refreshToken;

    await user.save({ validateBeforeSave: false });

    return res.status(200).json(
      new ApiResponse(
        200,
        {
          accessToken,
          refreshToken,
        },
        "Access token refreshed successfully"
      )
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

  return res.status(200).json(
    new ApiResponse(
      200,
      null,
      "User logged out successfully"
    )
  );
});