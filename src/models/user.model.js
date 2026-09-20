import mongoose from "mongoose";

const authProviderSchema = new mongoose.Schema(
  {
    provider: {
      type: String,
      enum: ["email", "phone", "google", "facebook", "apple"],
      required: true,
    },

    providerId: {
      type: String,
      required: true,
    },
  },
  {
    _id: false,
  }
);

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
      default: null,
    },

    email: {
      type: String,
      lowercase: true,
      trim: true,
      unique: true,
      sparse: true,
      default: null,
    },

    phone: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
      default: null,
    },

    password: {
      type: String,
      default: null,
    },

    role: {
      type: String,
      enum: ["user", "lawyer", "admin"],
      default: "user",
    },

    isVerified: {
      type: Boolean,
      default: false,
    },

    profileCompleted: {
      type: Boolean,
      default: false,
    },

    profileImage: {
      type: String,
      default: null,
    },

    authProviders: {
      type: [authProviderSchema],
      default: [],
    },

    otp: {
      type: String,
      default: null,
    },

    otpExpiresAt: {
      type: Date,
      default: null,
    },

    refreshToken: {
      type: String,
      default: null,
    },

    isDeleted: {
      type: Boolean,
      default: false,
    },

    deletedAt: {
      type: Date,
      default: null,
    },

    lastLoginAt: {
      type: Date,
      default: null,
    },

    assignedServices: [
  {
    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Service",
      required: true,
    },

    status: {
      type: String,
      enum: [
        "assigned",
        "in-progress",
        "completed",
        "cancelled",
      ],
      default: "assigned",
    },

    assignedAt: {
      type: Date,
      default: Date.now,
    },

    completedAt: {
      type: Date,
      default: null,
    },

    progress: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
  },
],
  },
  {
    timestamps: true,
  }
);

export const User = mongoose.model("User", userSchema);