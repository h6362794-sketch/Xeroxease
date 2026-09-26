// Zod validation schemas — every external input passes through here.

import { z } from "zod";
import {
  ALLOWED_UPLOAD_TYPES,
  COLOR_MODES,
  FINISHING_OPTIONS,
  PAPER_SIZES,
  PRINT_SIDES,
} from "@/lib/constants";

const password = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password too long")
  .regex(/[a-z]/, "Must include a lowercase letter")
  .regex(/[A-Z]/, "Must include an uppercase letter")
  .regex(/[0-9]/, "Must include a digit");

export const registerSchema = z
  .object({
    name: z.string().trim().min(2, "Name too short").max(80, "Name too long"),
    email: z.string().trim().toLowerCase().email("Invalid email").max(120),
    phone: z
      .string()
      .trim()
      .regex(/^[0-9+\-\s]{8,15}$/, "Invalid phone number"),
    regNo: z.string().trim().min(3, "Registration number too short").max(32),
    branch: z.string().trim().min(2).max(60),
    section: z.string().trim().min(1).max(8),
    year: z.coerce.number().int().min(1).max(6),
    password,
    confirmPassword: z.string(),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export const loginSchema = z.object({
  identifier: z.string().trim().min(3).max(120),
  password: z.string().min(1).max(128),
});

export const adminLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(128),
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(10).max(200),
  password,
});

export const finishingEnum = z.enum(FINISHING_OPTIONS);

export const orderConfigSchema = z.object({
  paperSize: z.enum(PAPER_SIZES),
  colorMode: z.enum(COLOR_MODES),
  sides: z.enum(PRINT_SIDES),
  copies: z.coerce.number().int().min(1).max(100),
  pageSelection: z.enum(["ALL", "CUSTOM"]),
  customPages: z.string().max(200).optional(),
  finishing: z.array(finishingEnum).max(3).default([]),
});

export const paymentSubmitSchema = z.object({
  reference: z.string().trim().min(4, "Reference too short").max(64),
});

export const feedbackSchema = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).optional().or(z.literal("")),
});

export const cancelSchema = z.object({
  reason: z.string().trim().max(300).optional().or(z.literal("")),
});

export const pricingUpdateSchema = z.object({
  items: z
    .array(
      z.object({
        key: z.string().min(2).max(40),
        unitPrice: z.coerce.number().min(0).max(100000),
        isActive: z.boolean().optional(),
      })
    )
    .min(1)
    .max(50),
});

export const adminStatusUpdateSchema = z.object({
  status: z.string().min(4).max(40),
  note: z.string().trim().max(500).optional().or(z.literal("")),
});

export const pageCorrectionSchema = z.object({
  fileId: z.string().uuid(),
  pageCount: z.coerce.number().int().min(1).max(10000),
});

export const createUserSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().regex(/^[0-9+\-\s]{8,15}$/).optional().or(z.literal("")),
  password,
  role: z.enum(["ADMIN", "SUPER_ADMIN"]),
});

export const fileMetaSchema = z.object({
  name: z.string().min(1).max(255),
  size: z.coerce.number().int().min(1),
  type: z.string().max(120),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type OrderConfigInput = z.infer<typeof orderConfigSchema>;
