import { User } from "../models/user.model.js";
import { Service } from "../models/service.model.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";

export const assignServiceToUser = asyncHandler(
  async (req, res) => {
    const { serviceId } = req.params;

    const userId = req.user._id;

    const service = await Service.findOne({
      _id: serviceId,
      isActive: true,
    });

    if (!service) {
      throw new ApiError(
        404,
        "Service not found"
      );
    }

    const user = await User.findById(userId);

    if (!user) {
      throw new ApiError(
        404,
        "User not found"
      );
    }

    const alreadyAssigned =
      user.assignedServices.some(
        (item) =>
          item.serviceId.toString() ===
          serviceId.toString()
      );

    if (alreadyAssigned) {
      throw new ApiError(
        409,
        "Service is already assigned to this user"
      );
    }

    user.assignedServices.push({
      serviceId: service._id,
      status: "assigned",
      assignedAt: new Date(),
      progress: 0,
    });

    await user.save();

    return res.status(201).json(
      new ApiResponse(
        201,
        {
          service,
        },
        "Service assigned successfully"
      )
    );
  }
);

export const getUserServices = asyncHandler(
  async (req, res) => {
    const user = await User.findById(req.user._id)
      .populate("assignedServices.serviceId")
      .select("assignedServices");

    if (!user) {
      throw new ApiError(
        404,
        "User not found"
      );
    }

    return res.status(200).json(
      new ApiResponse(
        200,
        user.assignedServices,
        "User services fetched successfully"
      )
    );
  }
);

export const getUserServiceById = asyncHandler(
  async (req, res) => {
    const { serviceId } = req.params;

    const user = await User.findOne({
      _id: req.user._id,
      "assignedServices.serviceId": serviceId,
    }).populate("assignedServices.serviceId");

    if (!user) {
      throw new ApiError(
        404,
        "Service is not assigned to this user"
      );
    }

    const assignedService =
      user.assignedServices.find(
        (item) =>
          item.serviceId?._id.toString() ===
          serviceId.toString()
      );

    if (!assignedService) {
      throw new ApiError(
        404,
        "Service is not assigned to this user"
      );
    }

    return res.status(200).json(
      new ApiResponse(
        200,
        assignedService,
        "Service fetched successfully"
      )
    );
  }
);