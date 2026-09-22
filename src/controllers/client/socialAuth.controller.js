import { User } from "../../models/user.model.js";
import {
  generateAccessToken,
  generateRefreshToken,
} from "../../utils/generateToken.js";
import { OAuth2Client } from "google-auth-library";
import ApiError from "../../utils/ApiError.js";
import ApiResponse from "../../utils/ApiResponse.js";
import asyncHandler from "../../utils/asyncHandler.js";
import axios from "axios";

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

export const authenticateSocialUser = async ({
  provider,
  providerId,
  email,
  name,
  profileImage,
}) => {
  let user = await User.findOne({
    "authProviders.provider": provider,
    "authProviders.providerId": providerId,
    isDeleted: false,
  });

  if (!user && email) {
    user = await User.findOne({
      email: email.toLowerCase(),
      isDeleted: false,
    });

    if (user) {
      const alreadyLinked = user.authProviders.some(
        (item) => item.provider === provider && item.providerId === providerId,
      );

      if (!alreadyLinked) {
        user.authProviders.push({
          provider,
          providerId,
        });
      }
    }
  }

  let isNewUser = false;

  if (!user) {
    user = await User.create({
      name: name || null,
      email: email?.toLowerCase() || null,
      profileImage: profileImage || null,
      isVerified: true,
      authProviders: [
        {
          provider,
          providerId,
        },
      ],
    });

    isNewUser = true;
  }

  if (name && !user.name) {
    user.name = name;
  }

  if (profileImage && !user.profileImage) {
    user.profileImage = profileImage;
  }

  user.isVerified = true;
  user.lastLoginAt = new Date();

  const accessToken = generateAccessToken({
    _id: user._id,
  });

  const refreshToken = generateRefreshToken({
    _id: user._id,
  });

  user.refreshToken = refreshToken;

  await user.save({
    validateBeforeSave: false,
  });

  const safeUser = await User.findById(user._id).select(
    "-password -refreshToken -otp -otpExpiresAt",
  );

  return {
    user: safeUser,
    accessToken,
    refreshToken,
    isNewUser,
  };
};

export const googleAuth = asyncHandler(async (req, res) => {
  const { credential } = req.body;

  if (!credential) {
    throw new ApiError(400, "Google credential is required");
  }

  const ticket = await googleClient.verifyIdToken({
    idToken: credential,
    audience: process.env.GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();

  if (!payload) {
    throw new ApiError(401, "Invalid Google credential");
  }

  const { sub, email, email_verified, name, picture } = payload;

  if (!sub) {
    throw new ApiError(401, "Google user ID is missing");
  }

  if (!email || !email_verified) {
    throw new ApiError(400, "A verified Google email is required");
  }

  const result = await authenticateSocialUser({
    provider: "google",
    providerId: sub,
    email,
    name,
    profileImage: picture,
  });

  // Set your own authentication cookies
  res.cookie("accessToken", result.accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: 15 * 60 * 1000,
  });

  res.cookie("refreshToken", result.refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  const status = result.isNewUser ? 201 : 200;

  return res.status(status).json(
    new ApiResponse(
      status,
      {
        user: result.user,
        isNewUser: result.isNewUser,
      },
      result.isNewUser
        ? "Google account created successfully"
        : "Google login successful",
    ),
  );
});

export const facebookAuth = asyncHandler(async (req, res) => {
  const { accessToken } = req.body;

  if (!accessToken) {
    throw new ApiError(400, "Facebook access token is required");
  }

  const response = await axios.get("https://graph.facebook.com/me", {
    params: {
      fields: "id,name,email,picture",
      access_token: accessToken,
    },
  });

  const facebookUser = response.data;

  if (!facebookUser?.id) {
    throw new ApiError(401, "Invalid Facebook access token");
  }

  const result = await authenticateSocialUser({
    provider: "facebook",
    providerId: facebookUser.id,
    email: facebookUser.email || null,
    name: facebookUser.name || null,
    profileImage: facebookUser.picture?.data?.url || null,
  });

  res.cookie("accessToken", result.accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: 15 * 60 * 1000,
  });

  res.cookie("refreshToken", result.refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  const status = result.isNewUser ? 201 : 200;

  return res.status(status).json(
    new ApiResponse(
      status,
      {
        user: result.user,
        isNewUser: result.isNewUser,
      },
      result.isNewUser
        ? "Facebook account created successfully"
        : "Facebook login successful",
    ),
  );
});
