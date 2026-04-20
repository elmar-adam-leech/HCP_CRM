import { z } from "zod";

// Shared Zod validation schemas used across multiple forms in the application.
// Centralizing these prevents validation rules from drifting out of sync between
// LeadForm, PublicBooking, LocalSchedulingModal, and other entry points.
//
// When adding a new validation rule, change it here and it will propagate
// automatically to every form that imports from this file.

/** Validates a phone number string — must be at least 10 digits when stripped of formatting. */
export const phoneSchema = z
  .string()
  .refine(
    (val) => !val || val.replace(/\D/g, "").length >= 10,
    { message: "Phone number must be at least 10 digits" }
  )
  .optional();

/** Validates a required phone number — same rule as phoneSchema but not optional. */
export const phoneRequiredSchema = z
  .string()
  .min(1, "Phone number is required")
  .refine(
    (val) => val.replace(/\D/g, "").length >= 10,
    { message: "Phone number must be at least 10 digits" }
  );

/** Validates a standard email address (optional field). */
export const emailOptionalSchema = z
  .string()
  .email("Please enter a valid email address")
  .optional()
  .or(z.literal(""));

/** Validates a contact's full name. */
export const contactNameSchema = z
  .string()
  .min(1, "Name is required")
  .max(200, "Name must be less than 200 characters");

/** Validates a freeform address string (optional). */
export const addressSchema = z
  .string()
  .max(500, "Address must be less than 500 characters")
  .optional();
