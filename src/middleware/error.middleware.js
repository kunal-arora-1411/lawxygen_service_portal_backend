import ApiError from "../utils/ApiError.js";

const errorMiddleware = (err, req, res, next) => {
  let error = err;

  if (!(error instanceof ApiError)) {
    const statusCode = error.statusCode || (error.name === "ValidationError" ? 400 : 500);
    const message = error.message || "Something went wrong";

    error = new ApiError(statusCode, message, error.errors || [], err.stack);
  }

  return res.status(error.statusCode).json({
    statusCode: error.statusCode,
    success: false,
    message: error.message,
    data: null,
    ...(process.env.NODE_ENV !== "production" && { errors: error.errors, stack: error.stack }),
  });
};

export default errorMiddleware;
