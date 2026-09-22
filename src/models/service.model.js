import mongoose from "mongoose";

const serviceServiceSchema = new mongoose.Schema(
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
      lowercase: true,
      trim: true,
      index: true,
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
      index: true,
    },

    accent: {
      type: String,
      default: "",
    },

    variant: {
      type: Number,
      default: null,
    },

    archetype: {
      type: String,
      default: "",
      trim: true,
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
      type: [
        {
          type: [String],
        },
      ],
      default: [],
    },

    overview: {
      type: [String],
      default: [],
    },

    benefits: {
      type: [
        {
          type: [String],
        },
      ],
      default: [],
    },

    documents: {
      type: [
        {
          type: [String],
        },
      ],
      default: [],
    },

    process: {
      type: [
        {
          type: [String],
        },
      ],
      default: [],
    },

    faqs: {
      type: [
        {
          type: [String],
        },
      ],
      default: [],
    },

    related: {
      type: [
        {
          title: {
            type: String,
            required: true,
          },

          href: {
            type: String,
            required: true,
          },
        },
      ],
      default: [],
    },

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
      default: "",
    },

    soft: {
      type: String,
      default: "",
    },

    price: {
      type: Number,
      default: 0,
      min: 0,
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

const Service = mongoose.model("Service", serviceServiceSchema);

export default Service;