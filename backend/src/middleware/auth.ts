/**
 * auth.ts
 *
 * JWT middleware. Tokens are issued by POST /api/users/auth after the client
 * signs a challenge with their Stellar private key (Freighter).
 *
 * The JWT payload carries { sub: stellarAddress, v: tokenVersion }.
 *
 * Sessions are tracked in the UserSession table for revocation support (issue #172).
 * When a user logs out or signs in again, their token version is incremented,
 * invalidating all tokens with a lower version number.
 */

import { RequestHandler } from "express";
import { jwtVerify } from "jose";
import { prisma } from "../db";
import { config } from "../config";
import { AppError } from "./errorHandler";

const secret = new TextEncoder().encode(config.JWT_SECRET);

export interface AuthLocals {
  stellarAddress: string;
}

export async function verifyAuthToken(token: string): Promise<string> {
  const { payload } = await jwtVerify(token, secret);
  if (typeof payload.sub !== "string") throw new Error();

  const tokenVersion = typeof payload.v === "number" ? payload.v : 0;
  const user = await prisma.user.findUnique({
    where: { stellarAddress: payload.sub },
    select: { id: true, sessions: { select: { tokenVersion: true }, take: 1 } },
  });

  if (!user) {
    throw new AppError(401, "User not found");
  }

  if (user.sessions.length > 0) {
    const latestSession = user.sessions[0];
    if (tokenVersion < latestSession.tokenVersion) {
      throw new AppError(401, "Token has been revoked");
    }
  }

  return payload.sub;
}

export const requireAuth: RequestHandler = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return next(new AppError(401, "Missing authorization header"));
  }
  try {
    const token = header.slice(7);
    const sub = await verifyAuthToken(token);
    res.locals.stellarAddress = sub;
    next();
  } catch (err) {
    if (err instanceof AppError) {
      next(err);
    } else {
      next(new AppError(401, "Invalid or expired token"));
    }
  }
};

/**
 * Optional authentication middleware.
 * If a valid Bearer token is provided, sets res.locals.stellarAddress.
 * If no authorization header is provided or token is invalid/expired, continues as unauthenticated.
 */
export const optionalAuth: RequestHandler = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return next();
  }
  try {
    const token = header.slice(7);
    const { payload } = await jwtVerify(token, secret);
    if (typeof payload.sub === "string") {
      const tokenVersion = typeof payload.v === "number" ? payload.v : 0;
      const user = await prisma.user.findUnique({
        where: { stellarAddress: payload.sub },
        select: { id: true, sessions: { select: { tokenVersion: true }, take: 1 } },
      });
      if (user && (user.sessions.length === 0 || tokenVersion >= user.sessions[0].tokenVersion)) {
        res.locals.stellarAddress = payload.sub;
      }
    }
  } catch {
    // Treat invalid or expired token as unauthenticated caller for optional auth
  }
  next();
};

