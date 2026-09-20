import { User } from "../models/user.model.js";
import {
  generateAccessToken,
  generateRefreshToken,
} from "../utils/generateToken.js";

export const authenticateSocialUser = async ({
  provider,
  providerId,
  email,
  name,
  profileImage,
}) => {
  // --------------------------------
  // 1. Find by provider ID
  // --------------------------------

  let user = await User.findOne({
    "authProviders.provider": provider,
    "authProviders.providerId": providerId,
    isDeleted: false,
  });

  // --------------------------------
  // 2. If provider doesn't exist,
  //    try verified email
  // --------------------------------

  if (!user && email) {
    user = await User.findOne({
      email: email.toLowerCase(),
      isDeleted: false,
    });

    // Link this provider to existing account
    if (user) {
      const alreadyLinked = user.authProviders.some(
        (item) =>
          item.provider === provider &&
          item.providerId === providerId
      );

      if (!alreadyLinked) {
        user.authProviders.push({
          provider,
          providerId,
        });
      }
    }
  }

  // --------------------------------
  // 3. Create new user
  // --------------------------------

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

  // --------------------------------
  // 4. Update profile information
  // --------------------------------

  if (name && !user.name) {
    user.name = name;
  }

  if (profileImage && !user.profileImage) {
    user.profileImage = profileImage;
  }

  user.isVerified = true;
  user.lastLoginAt = new Date();

  // --------------------------------
  // 5. Generate Lawxygen tokens
  // --------------------------------

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
    "-password -refreshToken -otp -otpExpiresAt"
  );

  return {
    user: safeUser,
    accessToken,
    refreshToken,
    isNewUser,
  };
};