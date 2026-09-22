import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env["NODE_ENV"] === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

if (process.env["NODE_ENV"] !== "production") globalForPrisma.prisma = prisma;

export * from "@prisma/client";
export { chargeMonthlyInvoice, runMonthlyBilling, currentPeriod } from "./billing.js";
export type { BillingResult } from "./billing.js";
export { reconcileStaleCalls } from "./calls.js";
export type { ReconcileStaleCallsResult } from "./calls.js";
