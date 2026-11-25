import type { RequestHandler } from "express";
import { AppError } from "./errorHandler";

const jsonMutationMethods = new Set(["POST", "PUT", "PATCH"]);

export const requireJsonContentType: RequestHandler = (req, _res, next) => {
  const hasBody = Number(req.headers["content-length"]) > 0 ||
    req.headers["transfer-encoding"] !== undefined;

  if (jsonMutationMethods.has(req.method) && hasBody && !req.is("application/json")) {
    return next(new AppError(415, "Request body must be application/json", "UNSUPPORTED_MEDIA_TYPE"));
  }

  next();
};
