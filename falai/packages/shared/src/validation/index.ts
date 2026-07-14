import { z } from "zod";

// E.164 phone number (Angola prefix validation)
export const phoneSchema = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, "Número deve estar no formato E.164 (ex: +244923000000)");

export const angolaPhoneSchema = z
  .string()
  .regex(/^\+244[29]\d{8}$/, "Número angolano inválido (ex: +244923000000)");

// Admin auth
export const adminLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export const adminTotpSchema = z.object({
  sessionToken: z.string(),
  code: z.string().length(6).regex(/^\d{6}$/),
});

// System setting
export const systemSettingUpsertSchema = z.object({
  key: z.string().min(1).max(100),
  value: z.string(),
  isSecret: z.boolean().optional(),
});

// Test call (internal)
export const testCallSchema = z.object({
  toNumber: phoneSchema,
  message: z.string().min(1).max(500).optional(),
});

export type AdminLoginInput = z.infer<typeof adminLoginSchema>;
export type AdminTotpInput = z.infer<typeof adminTotpSchema>;
export type SystemSettingUpsertInput = z.infer<typeof systemSettingUpsertSchema>;
export type TestCallInput = z.infer<typeof testCallSchema>;
