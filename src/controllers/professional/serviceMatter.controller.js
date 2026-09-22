import mongoose from "mongoose";
import ServiceMatter from "../../models/serviceMatter.model.js";

/**
 * GET PROFESSIONAL'S ASSIGNED MATTERS
 *
 * GET /api/professional/service-matters
 */
export const getProfessionalServiceMatters = async (req, res) => {
  try {
    const professionalId = req.user._id;

    const { status, page = 1, limit = 20 } = req.query;

    const query = { professional: professionalId };

    if (status) {
      query.status = status;
    }

    const pageNumber = Math.max(Number(page), 1);
    const limitNumber = Math.min(Math.max(Number(limit), 1), 100);
    const skip = (pageNumber - 1) * limitNumber;

    const [matters, total] = await Promise.all([
      ServiceMatter.find(query)
        .populate("client", "name email phone")
        .populate("service", "title slug category categorySlug")
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limitNumber)
        .lean(),

      ServiceMatter.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      data: matters,
      pagination: {
        page: pageNumber,
        limit: limitNumber,
        total,
        totalPages: Math.ceil(total / limitNumber),
      },
    });
  } catch (error) {
    console.error("Get professional service matters error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch assigned services",
      error: error.message,
    });
  }
};

/**
 * GET /api/professional/service-matters/:matterId
 */
export const getProfessionalServiceMatter = async (req, res) => {
  try {
    const professionalId = req.user._id;
    const { matterId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(matterId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid matter ID",
      });
    }

    const matter = await ServiceMatter.findOne({
      _id: matterId,
      professional: professionalId,
    })
      .populate("client", "name email phone")
      .populate("service", "title slug category categorySlug process")
      .lean();

    if (!matter) {
      return res.status(404).json({
        success: false,
        message: "Assigned service matter not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: matter,
    });
  } catch (error) {
    console.error("Get professional service matter error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch service matter",
      error: error.message,
    });
  }
};

/**
 * PATCH /api/professional/service-matters/:matterId/progress
 */
export const updateMatterProgress = async (req, res) => {
  try {
    const professionalId = req.user._id;
    const { matterId } = req.params;
    const { progress, currentStep, currentStepTitle } = req.body;

    if (!mongoose.Types.ObjectId.isValid(matterId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid matter ID",
      });
    }

    if (progress !== undefined && (progress < 0 || progress > 100)) {
      return res.status(400).json({
        success: false,
        message: "Progress must be between 0 and 100",
      });
    }

    const matter = await ServiceMatter.findOne({
      _id: matterId,
      professional: professionalId,
    });

    if (!matter) {
      return res.status(404).json({
        success: false,
        message: "Service matter not found or not assigned to you",
      });
    }

    if (progress !== undefined) {
      matter.progress = progress;
    }

    if (currentStep !== undefined) {
      matter.currentStep = currentStep;
    }

    if (currentStepTitle !== undefined) {
      matter.currentStepTitle = currentStepTitle;
    }

    if (matter.status === "ASSIGNED" && (progress > 0 || currentStep > 0)) {
      matter.status = "IN_PROGRESS";

      if (!matter.startedAt) {
        matter.startedAt = new Date();
      }
    }

    if (matter.progress === 100) {
      matter.status = "UNDER_REVIEW";
    }

    await matter.save();

    const updatedMatter = await ServiceMatter.findById(matter._id)
      .populate("client", "name email phone")
      .populate("service", "title slug category categorySlug")
      .populate("professional", "name email phone");

    return res.status(200).json({
      success: true,
      message: "Service progress updated successfully",
      data: updatedMatter,
    });
  } catch (error) {
    console.error("Update matter progress error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update progress",
      error: error.message,
    });
  }
};

/**
 * PATCH /api/professional/service-matters/:matterId/action
 */
export const requestClientAction = async (req, res) => {
  try {
    const professionalId = req.user._id;
    const { matterId } = req.params;
    const { actionMessage } = req.body;

    if (!actionMessage?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Action message is required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(matterId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid matter ID",
      });
    }

    const matter = await ServiceMatter.findOne({
      _id: matterId,
      professional: professionalId,
    });

    if (!matter) {
      return res.status(404).json({
        success: false,
        message: "Service matter not found or not assigned to you",
      });
    }

    matter.actionRequired = true;
    matter.actionMessage = actionMessage.trim();
    matter.status = "ACTION_REQUIRED";

    await matter.save();

    return res.status(200).json({
      success: true,
      message: "Action request sent to client successfully",
      data: matter,
    });
  } catch (error) {
    console.error("Request client action error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to request client action",
      error: error.message,
    });
  }
};
