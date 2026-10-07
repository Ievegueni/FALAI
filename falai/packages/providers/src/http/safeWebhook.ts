/**
 * Anti-SSRF para o webhook do cliente (Tenant.webhookUrl): o Falaí faz POST a
 * um URL escolhido pelo cliente a partir da nossa rede. Mesmas duas camadas do
 * urlGuard (endpoints de modelo): validação sintáctica + DNS validado no
 * momento da ligação (safeLookup), que fecha o DNS rebinding.
 */
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { assertSafeEndpointUrl, blockedIpLiteralReason, safeLookup } from "../llm/urlGuard.js";

/** http:// só fora de produção (testes locais com um receptor sem TLS). */
function httpAllowed(): boolean {
  return process.env["NODE_ENV"] !== "production";
}

/** Validação sintáctica. Lança Error com mensagem pronta a mostrar ao cliente. */
export function assertSafeWebhookUrl(rawUrl: string): URL {
  try {
    return assertSafeEndpointUrl(rawUrl, { allowHttp: httpAllowed() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(msg.replace(/(endpoint|URL) do modelo/g, "URL do webhook"));
  }
}

/** Validação completa para o ponto de gravação: sintaxe + todos os IPs resolvidos públicos. */
export async function assertPublicWebhookUrl(rawUrl: string): Promise<URL> {
  const url = assertSafeWebhookUrl(rawUrl);
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(url.hostname, { all: true });
  } catch {
    throw new Error(`Não foi possível resolver "${url.hostname}".`);
  }
  for (const { address } of addresses) {
    const reason = blockedIpLiteralReason(address);
    if (reason) throw new Error(`O host "${url.hostname}" resolve para um endereço interno (${address}) — ${reason}.`);
  }
  return url;
}

/**
 * POST para o webhook do cliente. Valida o URL e cada IP resolvido no momento
 * da ligação; não segue redirecções (node:http não as segue). Devolve o status.
 */
export async function postWebhook(rawUrl: string, headers: Record<string, string>, body: string, timeoutMs: number): Promise<number> {
  const url = assertSafeWebhookUrl(rawUrl);
  const isHttps = url.protocol === "https:";
  return new Promise<number>((resolve, reject) => {
    const req = (isHttps ? httpsRequest : httpRequest)(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body).toString() },
        lookup: safeLookup,
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`Timeout após ${timeoutMs} ms`)));
    req.on("error", reject);
    req.end(body);
  });
}
