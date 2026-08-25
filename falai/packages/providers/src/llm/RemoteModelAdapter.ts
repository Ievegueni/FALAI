import { createHmac } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import type { LlmProvider, TurnMessage } from "./LlmProvider.js";
import type { LlmTurnResponse } from "@falai/shared";
import { assertSafeEndpointUrl, safeLookup, BlockedAddressError } from "./urlGuard.js";

/**
 * Adaptador do produto API_BYOM ("bring your own model").
 *
 * O cliente traz o endpoint de inferência dele; o Falaí continua dono da telefonia,
 * STT, TTS e dos guardrails. A cada turno da chamada, em vez de chamar o Claude da
 * plataforma, fazemos um POST ao endpoint do cliente.
 *
 * ── Autenticação do nosso lado para o lado dele ───────────────────────────────
 * `authType`:
 *   - "BEARER"  → `Authorization: Bearer <authSecret>`
 *   - "HEADER"  → `<authHeaderName>: <authSecret>`
 *   - "NONE"    → sem cabeçalho de autenticação
 *
 * ── Assinatura do corpo (opcional, `signingSecret`) ───────────────────────────
 * Quando o cliente configura um segredo de assinatura, cada pedido leva:
 *
 *   X-Falai-Timestamp: <epoch em milissegundos>
 *   X-Falai-Signature: sha256=<hex>
 *
 * onde `<hex>` = HMAC-SHA256( key = signingSecret, msg = `${timestamp}.${body}` ),
 * com `body` a ser exactamente os bytes JSON enviados. Do lado do cliente, para
 * verificar: recalcular o HMAC com o corpo cru (não re-serializado!) e comparar em
 * tempo constante; rejeitar timestamps com mais de ~5 minutos para travar replays.
 *
 * ── Protocolos ────────────────────────────────────────────────────────────────
 *  - FALAI_TURN         → contrato nativo, o modelo devolve `{ reply, action }`.
 *  - OPENAI_CHAT        → compatível com POST /v1/chat/completions.
 *  - ANTHROPIC_MESSAGES → compatível com POST /v1/messages.
 *
 * Nos dois últimos o modelo devolve só texto, sem `action`. Regra de interpretação:
 * se o texto for um JSON válido com `{ reply, action }`, usamos esse objecto; caso
 * contrário assumimos `action = { type: "continue" }` e o texto inteiro como `reply`.
 * Ou seja, um modelo "burro" nunca desliga a chamada por acidente — para terminar,
 * escalar ou capturar dados tem mesmo de devolver o JSON.
 */

/** Timeout por omissão, em ms. Curto de propósito: isto corre com o chamador em linha. */
const DEFAULT_TIMEOUT_MS = 4_000;

/** Limite de caracteres da resposta que vai para TTS (≈45-60 s de fala). */
const DEFAULT_MAX_REPLY_CHARS = 800;

/** Tecto de tokens pedido aos protocolos de texto puro. */
const DEFAULT_MAX_TOKENS = 512;

/** Temperatura usada no protocolo OPENAI_CHAT (o Anthropic fica no default dele). */
const DEFAULT_TEMPERATURE = 0.7;

/** Falhas consecutivas a partir das quais o disjuntor abre. */
const BREAKER_FAILURE_THRESHOLD = 3;

/** Tempo que o disjuntor fica aberto antes de deixar passar um novo pedido. */
const BREAKER_OPEN_MS = 30_000;

/**
 * Tecto do corpo da resposta. Um endpoint hostil (ou avariado) que responda sem
 * fim esgotaria a memória do processo que está a servir chamadas ao vivo.
 */
const MAX_RESPONSE_BYTES = 1_000_000;

export type ModelProtocol = "FALAI_TURN" | "OPENAI_CHAT" | "ANTHROPIC_MESSAGES";

export interface RemoteModelConfig {
  endpointUrl: string;
  protocol: ModelProtocol;
  modelName?: string;          // exigido por OPENAI_CHAT / ANTHROPIC_MESSAGES
  authType: "BEARER" | "HEADER" | "NONE";
  authSecret?: string;         // já vem desencriptado de quem chama
  authHeaderName?: string;     // usado quando authType === "HEADER"
  timeoutMs: number;           // default 4000 se vier <= 0
  signingSecret?: string;      // HMAC-SHA256 do corpo, para o cliente confirmar que somos nós
  maxReplyChars?: number;      // default 800
  stubMode?: boolean;
}

export type RemoteModelErrorCode = "TIMEOUT" | "HTTP" | "CONTRACT" | "URL";

/**
 * Erro do endpoint do cliente. O `code` permite a quem chama distinguir
 * "ele demorou" (TIMEOUT) de "ele devolveu lixo" (CONTRACT) e escolher o fallback
 * — repetir, ler uma frase de espera, escalar para humano ou desligar.
 */
export class RemoteModelError extends Error {
  readonly code: RemoteModelErrorCode;
  readonly httpStatus?: number;

  constructor(code: RemoteModelErrorCode, message: string, httpStatus?: number) {
    super(message);
    this.name = "RemoteModelError";
    this.code = code;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
  }
}

/** Parâmetros de um turno. Estende o contrato de `LlmProvider` com metadados opcionais. */
export interface RemoteTurnParams {
  systemPrompt: string;
  history: TurnMessage[];
  userText: string;
  variables?: Record<string, unknown>;
  callId?: string;
  agentId?: string;
  locale?: string;
}

interface TurnResult {
  response: LlmTurnResponse;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

const ACTION_TYPES = ["continue", "end_call", "escalate", "capture"] as const;

export class RemoteModelAdapter implements LlmProvider {
  private config: RemoteModelConfig;

  // Estado do disjuntor (por instância do adaptador, ou seja, por agente/tenant).
  private consecutiveFailures = 0;
  private breakerOpenUntil = 0;

  constructor(config: RemoteModelConfig) {
    this.config = config;
  }

  // ---------------------------------------------------------------------------
  // Turno
  // ---------------------------------------------------------------------------

  async generateTurnResponse(params: RemoteTurnParams): Promise<TurnResult> {
    if (this.config.stubMode) {
      return this.stubResponse(params.userText);
    }

    // Disjuntor: falha imediata, sem tocar na rede.
    const now = Date.now();
    if (this.breakerOpenUntil > now) {
      const secondsLeft = Math.ceil((this.breakerOpenUntil - now) / 1000);
      throw new RemoteModelError(
        "HTTP",
        `Endpoint do modelo temporariamente desactivado após ${BREAKER_FAILURE_THRESHOLD} falhas consecutivas. Nova tentativa dentro de ${secondsLeft}s.`,
      );
    }

    // Validado a CADA chamada, não só na construção: o URL pode ter sido alterado
    // na base de dados desde que este adaptador foi instanciado.
    let url: URL;
    try {
      url = assertSafeEndpointUrl(this.config.endpointUrl);
    } catch (err) {
      // Um URL inválido não conta para o disjuntor — não é falha do endpoint remoto.
      throw new RemoteModelError("URL", err instanceof Error ? err.message : String(err));
    }

    const timeoutMs = this.config.timeoutMs > 0 ? this.config.timeoutMs : DEFAULT_TIMEOUT_MS;
    const systemPrompt = applyVariables(params.systemPrompt, params.variables);
    const body = this.buildBody({ ...params, systemPrompt });
    const payload = JSON.stringify(body);

    const startedAt = Date.now();
    let raw: unknown;
    try {
      raw = await this.post(url, payload, timeoutMs);
    } catch (err) {
      this.recordFailure();
      throw err;
    }
    const durationMs = Date.now() - startedAt;

    let parsed: TurnResult;
    try {
      const { response, inputTokens, outputTokens } = this.parseResponse(raw);
      parsed = { response, durationMs, inputTokens, outputTokens };
    } catch (err) {
      // Contrato violado conta como falha: um endpoint que devolve lixo é tão
      // inútil como um que não responde.
      this.recordFailure();
      throw err;
    }

    this.consecutiveFailures = 0;
    this.breakerOpenUntil = 0;
    return parsed;
  }

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------

  /**
   * POST com timeout duro. Devolve o JSON já desserializado.
   *
   * Usa `node:https` em vez de `fetch` por uma razão só, mas decisiva: o `fetch` não
   * deixa passar um `lookup` personalizado, e é no `lookup` que se fecha o DNS
   * rebinding (ver urlGuard.safeLookup). Com o `fetch`, um domínio do cliente que
   * resolvesse para 169.254.169.254 passava por cima de toda a validação sintáctica.
   *
   * Efeito lateral bem-vindo: o `https.request` não segue redirecções, ponto — não
   * é preciso lembrar-se de as desligar, e um `302 → http://169.254.169.254/` deixa
   * de ser um vector.
   */
  private post(url: URL, payload: string, timeoutMs: number): Promise<unknown> {
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? httpsRequest : httpRequest;

    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      const req = transport(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || String(isHttps ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: "POST",
          headers: {
            ...this.buildHeaders(payload),
            "Content-Length": Buffer.byteLength(payload).toString(),
          },
          // A defesa que interessa: valida cada endereço resolvido antes de ligar.
          lookup: safeLookup,
        },
        (res) => {
          const status = res.statusCode ?? 0;

          if (status >= 300 && status < 400) {
            res.resume(); // liberta o socket
            return finish(() =>
              reject(
                new RemoteModelError(
                  "HTTP",
                  `O endpoint do modelo respondeu com uma redirecção (HTTP ${status}). ` +
                    `Redirecções não são seguidas — aponta o URL directamente ao endpoint final.`,
                  status,
                ),
              ),
            );
          }

          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            // Um endpoint hostil podia responder para sempre e esgotar a memória
            // do processo que está a servir chamadas.
            if (size > MAX_RESPONSE_BYTES) {
              req.destroy();
              return finish(() =>
                reject(
                  new RemoteModelError(
                    "CONTRACT",
                    `A resposta do modelo excedeu ${MAX_RESPONSE_BYTES} bytes.`,
                  ),
                ),
              );
            }
            chunks.push(chunk);
          });

          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");

            if (status < 200 || status >= 300) {
              return finish(() =>
                reject(
                  new RemoteModelError(
                    "HTTP",
                    `O endpoint do modelo devolveu HTTP ${status}: ${truncate(text, 300)}`,
                    status,
                  ),
                ),
              );
            }

            try {
              const parsed = JSON.parse(text) as unknown;
              finish(() => resolve(parsed));
            } catch {
              finish(() =>
                reject(
                  new RemoteModelError("CONTRACT", "O endpoint do modelo não devolveu JSON válido."),
                ),
              );
            }
          });
        },
      );

      req.setTimeout(timeoutMs, () => {
        req.destroy();
        finish(() =>
          reject(
            new RemoteModelError(
              "TIMEOUT",
              `O endpoint do modelo não respondeu em ${timeoutMs}ms (${url.host}).`,
            ),
          ),
        );
      });

      req.on("error", (err) => {
        // Um nome que resolve para dentro da nossa rede é uma tentativa de SSRF,
        // não uma falha de rede — merece a sua própria categoria e mensagem.
        if (err instanceof BlockedAddressError) {
          return finish(() => reject(new RemoteModelError("URL", err.message)));
        }
        finish(() =>
          reject(
            new RemoteModelError(
              "HTTP",
              `Falha de rede ao contactar o endpoint do modelo (${url.host}): ${err.message}`,
            ),
          ),
        );
      });

      req.end(payload);
    });
  }

  private buildHeaders(payload: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "Falai/1.0",
      Accept: "application/json",
    };

    if (this.config.authType === "BEARER" && this.config.authSecret) {
      headers["Authorization"] = `Bearer ${this.config.authSecret}`;
    } else if (this.config.authType === "HEADER" && this.config.authSecret && this.config.authHeaderName) {
      headers[this.config.authHeaderName] = this.config.authSecret;
    }

    if (this.config.signingSecret) {
      const timestamp = String(Date.now());
      const signature = createHmac("sha256", this.config.signingSecret)
        .update(`${timestamp}.${payload}`)
        .digest("hex");
      headers["X-Falai-Timestamp"] = timestamp;
      headers["X-Falai-Signature"] = `sha256=${signature}`;
    }

    return headers;
  }

  // ---------------------------------------------------------------------------
  // Corpo do pedido, por protocolo
  // ---------------------------------------------------------------------------

  private buildBody(params: RemoteTurnParams & { systemPrompt: string }): Record<string, unknown> {
    switch (this.config.protocol) {
      case "FALAI_TURN":
        return {
          ...(params.callId !== undefined && { callId: params.callId }),
          ...(params.agentId !== undefined && { agentId: params.agentId }),
          locale: params.locale ?? "pt-PT",
          systemPrompt: params.systemPrompt,
          history: params.history.map((m) => ({ role: m.role, text: m.text })),
          userText: params.userText,
          variables: params.variables ?? {},
        };

      case "OPENAI_CHAT": {
        const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
          { role: "system", content: params.systemPrompt },
          ...params.history.map((m) => ({ role: openAiRole(m.role), content: m.text })),
          { role: "user" as const, content: params.userText },
        ];
        return {
          model: this.requireModelName(),
          messages,
          max_tokens: DEFAULT_MAX_TOKENS,
          temperature: DEFAULT_TEMPERATURE,
        };
      }

      case "ANTHROPIC_MESSAGES": {
        // O Anthropic não aceita "system" dentro de `messages` — vai no campo próprio.
        const messages = [
          ...params.history
            .filter((m) => m.role !== "system")
            .map((m) => ({ role: m.role === "human" ? "user" : "assistant", content: m.text })),
          { role: "user", content: params.userText },
        ];
        return {
          model: this.requireModelName(),
          system: params.systemPrompt,
          messages,
          max_tokens: DEFAULT_MAX_TOKENS,
        };
      }
    }
  }

  private requireModelName(): string {
    const name = this.config.modelName?.trim();
    if (!name) {
      throw new RemoteModelError(
        "CONTRACT",
        `O protocolo ${this.config.protocol} exige o nome do modelo (modelName) na configuração.`,
      );
    }
    return name;
  }

  // ---------------------------------------------------------------------------
  // Leitura e normalização defensiva da resposta
  // ---------------------------------------------------------------------------

  private parseResponse(raw: unknown): {
    response: LlmTurnResponse;
    inputTokens: number;
    outputTokens: number;
  } {
    const obj = isRecord(raw) ? raw : {};
    const { inputTokens, outputTokens } = readUsage(obj);

    let candidate: unknown;

    switch (this.config.protocol) {
      case "FALAI_TURN":
        candidate = obj;
        break;

      case "OPENAI_CHAT": {
        const choices = obj["choices"];
        const first = Array.isArray(choices) ? choices[0] : undefined;
        const message = isRecord(first) ? first["message"] : undefined;
        const content = isRecord(message) ? message["content"] : undefined;
        if (typeof content !== "string") {
          throw new RemoteModelError(
            "CONTRACT",
            "Resposta OPENAI_CHAT sem texto em choices[0].message.content.",
          );
        }
        candidate = parseTextTurn(content);
        break;
      }

      case "ANTHROPIC_MESSAGES": {
        const content = obj["content"];
        const first = Array.isArray(content) ? content[0] : undefined;
        const text = isRecord(first) ? first["text"] : undefined;
        if (typeof text !== "string") {
          throw new RemoteModelError(
            "CONTRACT",
            "Resposta ANTHROPIC_MESSAGES sem texto em content[0].text.",
          );
        }
        candidate = parseTextTurn(text);
        break;
      }
    }

    return { response: this.normalizeTurn(candidate), inputTokens, outputTokens };
  }

  /**
   * Normalização defensiva: nada de lixo sobe para o motor de chamadas. Ou sai um
   * `LlmTurnResponse` válido, ou sai `RemoteModelError("CONTRACT")` — quem chama decide
   * o fallback.
   */
  private normalizeTurn(candidate: unknown): LlmTurnResponse {
    if (!isRecord(candidate)) {
      throw new RemoteModelError("CONTRACT", "O endpoint do modelo não devolveu um objecto de turno.");
    }

    const rawReply = candidate["reply"];
    if (typeof rawReply !== "string" || rawReply.trim() === "") {
      throw new RemoteModelError(
        "CONTRACT",
        'O endpoint do modelo devolveu um campo "reply" ausente, vazio ou que não é texto.',
      );
    }

    const maxChars = this.config.maxReplyChars && this.config.maxReplyChars > 0
      ? this.config.maxReplyChars
      : DEFAULT_MAX_REPLY_CHARS;
    const reply = truncateOnWord(rawReply.trim(), maxChars);

    const rawAction = candidate["action"];
    if (!isRecord(rawAction)) {
      throw new RemoteModelError(
        "CONTRACT",
        'O endpoint do modelo devolveu um campo "action" ausente ou que não é um objecto.',
      );
    }

    const type = rawAction["type"];
    if (typeof type !== "string" || !(ACTION_TYPES as readonly string[]).includes(type)) {
      throw new RemoteModelError(
        "CONTRACT",
        `Acção "${String(type)}" desconhecida. Valores aceites: ${ACTION_TYPES.join(", ")}.`,
      );
    }

    switch (type) {
      case "end_call":
        return { reply, action: { type: "end_call" } };
      case "escalate": {
        const to = rawAction["to"];
        return {
          reply,
          action: typeof to === "string" && to.trim() !== "" ? { type: "escalate", to: to.trim() } : { type: "escalate" },
        };
      }
      case "capture": {
        const data = rawAction["data"];
        return { reply, action: { type: "capture", data: isRecord(data) ? data : {} } };
      }
      default:
        return { reply, action: { type: "continue" } };
    }
  }

  // ---------------------------------------------------------------------------
  // Disjuntor
  // ---------------------------------------------------------------------------

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= BREAKER_FAILURE_THRESHOLD) {
      this.breakerOpenUntil = Date.now() + BREAKER_OPEN_MS;
    }
  }

  // ---------------------------------------------------------------------------
  // Stub e health check
  // ---------------------------------------------------------------------------

  private stubResponse(userText: string): TurnResult {
    return {
      response: {
        reply: `[stub BYOM] Recebi "${truncate(userText, 80)}". Em que mais posso ajudar?`,
        action: { type: "continue" },
      },
      durationMs: 40,
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  /**
   * Faz um turno mínimo real contra o endpoint do cliente e mede a latência.
   * É isto que alimenta o botão "testar modelo" no CRM.
   */
  /**
   * Turno mínimo real contra o endpoint do cliente. É o que alimenta o botão
   * "testar modelo" e mede a latência que ele vai ter em chamada.
   *
   * Não mexe no disjuntor: um cliente a afinar o endpoint carrega em "testar"
   * várias vezes seguidas, e três falhas nesse ecrã não podem deixar o modelo
   * em circuito aberto durante 30s. O disjuntor existe para proteger chamadas
   * ao vivo, não para castigar quem está a configurar.
   */
  async healthCheck(): Promise<{ ok: boolean; details?: string }> {
    if (this.config.stubMode) return { ok: true, details: "modo stub" };

    const savedFailures = this.consecutiveFailures;
    const savedOpenUntil = this.breakerOpenUntil;
    // Fecha o disjuntor durante o teste, para o teste chegar mesmo à rede.
    this.breakerOpenUntil = 0;

    const startedAt = Date.now();
    try {
      const result = await this.generateTurnResponse({
        systemPrompt: "És um assistente telefónico. Responde numa frase curta em português.",
        history: [],
        userText: "Olá",
        locale: "pt-PT",
      });
      const latencyMs = Date.now() - startedAt;
      return {
        ok: true,
        details: `ligado — ${latencyMs}ms totais (${result.durationMs}ms no pedido HTTP), resposta com ${result.response.reply.length} caracteres`,
      };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const code = err instanceof RemoteModelError ? err.code : "HTTP";
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, details: `${code} após ${latencyMs}ms — ${message}` };
    } finally {
      // Repõe o estado que havia antes do teste, em qualquer dos casos.
      this.consecutiveFailures = savedFailures;
      this.breakerOpenUntil = savedOpenUntil;
    }
  }
}

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function openAiRole(role: TurnMessage["role"]): "system" | "user" | "assistant" {
  if (role === "agent") return "assistant";
  if (role === "human") return "user";
  return "system";
}

/** Substitui {{variavel}} no system prompt, tal como o ClaudeAdapter faz. */
function applyVariables(prompt: string, variables?: Record<string, unknown>): string {
  if (!variables) return prompt;
  let out = prompt;
  for (const [key, val] of Object.entries(variables)) {
    out = out.replaceAll(`{{${key}}}`, String(val));
  }
  return out;
}

/**
 * Protocolos de texto puro: se o modelo devolveu JSON `{reply, action}`, usamo-lo;
 * senão o texto inteiro é a resposta e a chamada continua.
 * Tolera o texto embrulhado numa cerca ```json … ```.
 */
function parseTextTurn(text: string): unknown {
  const trimmed = stripCodeFence(text.trim());
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed) && typeof parsed["reply"] === "string" && isRecord(parsed["action"])) {
        return parsed;
      }
    } catch {
      // Não era JSON — segue como texto simples.
    }
  }
  return { reply: text.trim(), action: { type: "continue" } };
}

function stripCodeFence(text: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return match?.[1] ?? text;
}

function readUsage(obj: Record<string, unknown>): { inputTokens: number; outputTokens: number } {
  const usage = obj["usage"];
  if (!isRecord(usage)) return { inputTokens: 0, outputTokens: 0 };
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    // OpenAI: prompt_tokens/completion_tokens. Anthropic: input_tokens/output_tokens.
    inputTokens: num(usage["input_tokens"]) || num(usage["prompt_tokens"]) || num(usage["inputTokens"]),
    outputTokens: num(usage["output_tokens"]) || num(usage["completion_tokens"]) || num(usage["outputTokens"]),
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Trunca sem cortar a meio de uma palavra. */
function truncateOnWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  // Se não há espaço razoavelmente perto do fim, corta a seco (palavra única enorme).
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}
