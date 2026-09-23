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

    // No `default: null` here on purpose: a sparse unique index only skips
    // documents where the field is *absent*, not ones explicitly set to
    // null. Defaulting to null would make every account without an
    // email/phone collide on a duplicate-key error the second time it
    // happens.
    email: {
      type: String,
      lowercase: true,
      trim: true,
      unique: true,
      sparse: true,
    },

    phone: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
    },

    password: {
      type: String,
      default: null,
    },

    role: {
      type: String,
      enum: ["user", "professional", "admin", "super_admin"],
      default: "user",
    },

    isVerified: {
      type: Boolean,
      default: false,
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    location: {
      type: String,
      trim: true,
      default: null,
    },

    profileCompleted: {
      type: Boolean,
      default: false,
    },

    profileImage: {
      type: String,
      default: null,
    },

    // Only populated when role === "professional"
    professionalProfile: {
      title: {
        type: String,
        trim: true,
        default: "",
      },

      specialties: {
        type: [String],
        default: [],
      },

      languages: {
        type: [String],
        default: [],
      },

      availability: {
        type: String,
        enum: ["online", "in_call", "offline"],
        default: "offline",
      },
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