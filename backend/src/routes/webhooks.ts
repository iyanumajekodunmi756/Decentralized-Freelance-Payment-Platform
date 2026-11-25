/**
 * webhooks.ts
 *
 * REST API for managing external webhook subscriptions (issue #313).
 *
 * POST   /api/webhooks      — register a destination URL with HMAC secret
 * GET    /api/webhooks      — list registered webhooks
 * GET    /api/webhooks/:id  — get a single webhook subscription
 * DELETE /api/webhooks/:id  — remove a webhook subscription
 */

import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { validate } from "../middleware/validate";
import { AppError } from "../middleware/errorHandler";
import { optionalAuth } from "../middleware/auth";

export const webhooksRouter = Router();

export const createWebhookSchema = z.object({
  url: z.string().url("A valid HTTP or HTTPS destination URL is required"),
  secret: z.string().min(8, "HMAC secret must be at least 8 characters").optional(),
  events: z.array(z.string()).min(1).default(["*"]),
});

export const updateWebhookSchema = z.object({
  url: z.string().url().optional(),
  events: z.array(z.string()).min(1).optional(),
  isActive: z.boolean().optional(),
});

// POST /api/webhooks
webhooksRouter.post(
  "/",
  optionalAuth,
  validate(createWebhookSchema),
  async (req, res, next) => {
    try {
      const { url, events } = req.body;
      const secret = req.body.secret ?? crypto.randomBytes(32).toString("hex");

      let userId: string | undefined;
      if (res.locals.stellarAddress) {
        const user = await prisma.user.findUnique({
          where: { stellarAddress: res.locals.stellarAddress },
          select: { id: true },
        });
        if (user) userId = user.id;
      }

      const subscription = await prisma.webhookSubscription.create({
        data: {
          url,
          secret,
          events,
          userId,
        },
      });

      res.status(201).json(subscription);
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/webhooks
webhooksRouter.get("/", optionalAuth, async (_req, res, next) => {
  try {
    const subscriptions = await prisma.webhookSubscription.findMany({
      orderBy: { createdAt: "desc" },
    });
    res.json(subscriptions.map(({ secret: _secret, ...subscription }) => subscription));
  } catch (err) {
    next(err);
  }
});

// GET /api/webhooks/:id
webhooksRouter.get("/:id", async (req, res, next) => {
  try {
    const subscription = await prisma.webhookSubscription.findUnique({
      where: { id: req.params.id },
    });
    if (!subscription) {
      throw new AppError(404, "Webhook subscription not found");
    }
    const { secret: _secret, ...publicSubscription } = subscription;
    res.json(publicSubscription);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/webhooks/:id
webhooksRouter.delete("/:id", async (req, res, next) => {
  try {
    const existing = await prisma.webhookSubscription.findUnique({
      where: { id: req.params.id },
    });
    if (!existing) {
      throw new AppError(404, "Webhook subscription not found");
    }

    await prisma.webhookSubscription.delete({
      where: { id: req.params.id },
    });

    res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    next(err);
  }
});
