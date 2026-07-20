import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  JWT_SECRET: z.string().min(32),
  ENCRYPTION_KEY: z.string().length(32),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  // Origens permitidas em produção (lista separada por vírgulas). Se vazio, o CORS
  // fica bloqueado a cross-origin (adequado quando FE e API partilham origem/proxy).
  ALLOWED_ORIGINS: z.string().optional(),

  YEASTAR_BASE_URL: z.string().optional(),
  YEASTAR_CLIENT_ID: z.string().optional(),
  YEASTAR_CLIENT_SECRET: z.string().optional(),
  YEASTAR_STUB_MODE: z.coerce.boolean().default(true),
  YEASTAR_OUTBOUND_EXTENSION: z.string().default("1000"),

  DEEPGRAM_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  PROXYPAY_API_KEY: z.string().optional(),
  FUTURIX_SMS_API_KEY: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
