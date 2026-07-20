import { prisma } from "@falai/db";

/**
 * Lançado quando um tenant tenta fazer uma chamada de saída sem ter
 * nenhuma linha activa configurada. A extensão de saída passou a ser
 * obrigatória por cliente (deixou de existir fallback global).
 */
export class NoOutboundLineError extends Error {
  constructor() {
    super("O cliente não tem nenhuma linha de saída activa configurada");
    this.name = "NoOutboundLineError";
  }
}

/**
 * Resolve a extensão de saída de um tenant.
 *
 * Prioridade:
 *   1. Extensão explícita passada na request (chamada directa, OTP com param)
 *   2. Linha default activa do tenant (`TenantLine` isDefault && isActive)
 *   3. Qualquer linha activa (defensivo, caso nenhuma esteja marcada default)
 *
 * Se nada resolver, lança `NoOutboundLineError` — as chamadas de saída
 * exigem uma linha activa por cliente.
 */
export async function resolveOutboundExtension(
  tenantId: string,
  explicit?: string | null,
): Promise<string> {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;

  const line =
    (await prisma.tenantLine.findFirst({
      where: { tenantId, isActive: true, isDefault: true },
      select: { extension: true },
    })) ??
    (await prisma.tenantLine.findFirst({
      where: { tenantId, isActive: true },
      orderBy: { createdAt: "asc" },
      select: { extension: true },
    }));

  if (!line) throw new NoOutboundLineError();
  return line.extension;
}
