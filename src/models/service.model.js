import mongoose from "mongoose";

const serviceSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },

    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    category: {
      type: String,
      required: true,
      trim: true,
    },

    categorySlug: {
      type: String,
      required: true,
      trim: true,
    },

    accent: {
      type: String,
      default: null,
    },

    variant: {
      type: Number,
      default: null,
    },

    archetype: {
      type: String,
      default: null,
    },

    summary: {
      type: String,
      default: "",
    },

    highlights: {
      type: [String],
      default: [],
    },

    checklist: {
      type: [[String]],
      default: [],
    },

    overview: {
      type: [String],
      default: [],
    },

    benefits: {
      type: [[String]],
      default: [],
    },

    documents: {
      type: [[String]],
      default: [],
    },

    process: {
      type: [[String]],
      default: [],
    },

    faqs: {
      type: [[String]],
      default: [],
    },

    related: [
      {
        title: String,
        href: String,
      },
    ],

    cta: {
      type: String,
      default: "Start this service",
    },

    note: {
      type: String,
      default: "",
    },

    bg: {
      type: String,
      default: null,
    },

    soft: {
      type: String,
      default: null,
    },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

export const Service = mongoose.model("Service", serviceSchema);