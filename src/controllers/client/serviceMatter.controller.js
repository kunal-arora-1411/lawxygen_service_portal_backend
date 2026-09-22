import mongoose from "mongoose";
import ServiceMatter from "../../models/serviceMatter.model.js";
import Service from "../../models/service.model.js";

/**
 * CREATE SERVICE MATTER
 *
 * This should eventually be called after successful Razorpay payment.
 *
 * POST /api/client/serviceMatter
 */
export const assignServiceToLoggedInUser = async (req, res) => {
  try {
    const clientId = req.user._id;

    const { serviceId } = req.body;

    if (!serviceId) {
      return res.status(400).json({
        success: false,
        message: "serviceId is required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(serviceId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid service ID",
      });
    }

    const service = await Service.findOne({
      _id: serviceId,
      isActive: true,
    }).lean();

    if (!service) {
      return res.status(404).json({
        success: false,
        message: "Service not found",
      });
    }

    const existingMatter = await ServiceMatter.findOne({
      client: clientId,
      service: serviceId,
      status: {
        $nin: ["COMPLETED", "CANCELLED"],
      },
    });

    if (existingMatter) {
      return res.status(409).json({
        success: false,
        message: "You already have this service assigned",
        data: existingMatter,
      });
    }

    const matter = await ServiceMatter.create({
      client: clientId,
      service: service._id,
      serviceSnapshot: {
        title: service.title,
        slug: service.slug,
        price: service.price || 0,
      },

      // TEMPORARY: treated as paid because Razorpay is not integrated yet.
      status: "PAID",

      professional: null,
      progress: 0,
      currentStep: 0,
      totalSteps: Array.isArray(service.process)
        ? service.process.length
        : 0,
      currentStepTitle:
        Array.isArray(service.process) && service.process.length > 0
          ? service.process[0]?.[0] || ""
          : "",
      actionRequired: false,
      actionMessage: "",
    });

    const populatedMatter = await ServiceMatter.findById(matter._id)
      .populate("client", "name email phone")
      .populate("service", "title slug category categorySlug accent summary price")
      .populate("professional", "name email phone");

    return res.status(201).json({
      success: true,
      message: "Service assigned successfully",
      data: populatedMatter,
    });
  } catch (error) {
    console.error("Assign service to user error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to assign service",
      error: error.message,
    });
  }
};

/**
 * GET /api/client/serviceMatter
 */
export const getClientServiceMatters = async (req, res) => {
  try {
    const clientId = req.user._id;

    const matters = await ServiceMatter.find({
      client: clientId,
    })
      .populate("service", "title slug category categorySlug accent summary price")
      .populate("professional", "name email phone")
      .sort({ updatedAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      data: matters,
    });
  } catch (error) {
    console.error("Get client service matters error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch your services",
      error: error.message,
    });
  }
};

/**
 * GET /api/client/serviceMatter/:matterId
 */
export const getClientServiceMatter = async (req, res) => {
  try {
    const clientId = req.user._id;
    const { matterId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(matterId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid matter ID",
      });
    }

    const matter = await ServiceMatter.findOne({
      _id: matterId,
      client: clientId,
    })
      .populate("service", "title slug category categorySlug accent summary price process")
      .populate("professional", "name email phone")
      .lean();

    if (!matter) {
      return res.status(404).json({
        success: false,
        message: "Service matter not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: matter,
    });
  } catch (error) {
    console.error("Get client service matter error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch service matter",
      error: error.message,
    });
  }
};

/**
 * PATCH /api/client/serviceMatter/:matterId/action/resolve
 */
export const resolveClientAction = async (req, res) => {
  try {
    const clientId = req.user._id;
    const { matterId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(matterId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid matter ID",
      });
    }

    const matter = await ServiceMatter.findOne({
      _id: matterId,
      client: clientId,
    });

    if (!matter) {
      return res.status(404).json({
        success: false,
        message: "Service matter not found",
      });
    }

    matter.actionRequired = false;
    matter.actionMessage = "";

    if (matter.professional) {
      matter.status = "IN_PROGRESS";
    } else {
      matter.status = "PAID";
    }

    await matter.save();

    return res.status(200).json({
      success: true,
      message: "Action request resolved",
      data: matter,
    });
  } catch (error) {
    console.error("Resolve client action error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to resolve action",
      error: error.message,
    });
  }
};
