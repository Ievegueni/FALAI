/**
 * ALLOWED_ORIGINS: lista separada por vírgulas. Uma entrada com "*." aceita
 * qualquer subdomínio de um nível (ex.: "https://*.falai.ao" → os endereços
 * próprios dos clientes); as outras têm de ser exactas.
 */
export function parseAllowedOrigins(value: string | undefined): (string | RegExp)[] {
  return (value ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => {
      const m = /^(https?):\/\/\*\.(.+)$/.exec(o);
      if (!m) return o;
      const host = m[2]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`^${m[1]}://[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.${host}$`);
    });
}
