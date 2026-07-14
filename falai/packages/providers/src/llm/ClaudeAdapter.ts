import Anthropic from "@anthropic-ai/sdk";
import type { LlmProvider, TurnMessage } from "./LlmProvider.js";
import type { LlmTurnResponse } from "@falai/shared";

export interface ClaudeConfig {
  apiKey: string;
  model?: string;   // default "claude-sonnet-4-6"
  maxTokens?: number;
  stubMode?: boolean;
}

const RESPOND_TOOL_NAME = "respond_to_caller";

const RESPOND_TOOL: Anthropic.Tool = {
  name: RESPOND_TOOL_NAME,
  description: "Responde ao chamador e indica a próxima acção da chamada.",
  input_schema: {
    type: "object" as const,
    properties: {
      reply: {
        type: "string",
        description: "O que dizer ao chamador (será convertido em voz). Frases curtas e claras.",
      },
      action: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["continue", "end_call", "escalate", "capture"],
            description: "continue=continuar conversa; end_call=encerrar; escalate=transferir para humano; capture=guardar dados recolhidos",
          },
          to: { type: "string", description: "Número para escalate" },
          data: { type: "object", description: "Dados capturados (para action.type=capture)" },
        },
        required: ["type"],
      },
    },
    required: ["reply", "action"],
  },
};

export class ClaudeAdapter implements LlmProvider {
  private client: Anthropic;
  private config: ClaudeConfig;

  constructor(config: ClaudeConfig) {
    this.config = config;
    this.client = new Anthropic({ apiKey: config.apiKey });
  }

  async generateTurnResponse(params: {
    systemPrompt: string;
    history: TurnMessage[];
    userText: string;
    variables?: Record<string, unknown>;
  }): Promise<{
    response: LlmTurnResponse;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
  }> {
    if (this.config.stubMode) {
      return this.stubResponse(params.userText);
    }

    const startedAt = Date.now();

    // Inject variables into system prompt
    let systemPrompt = params.systemPrompt;
    if (params.variables) {
      for (const [key, val] of Object.entries(params.variables)) {
        systemPrompt = systemPrompt.replaceAll(`{{${key}}}`, String(val));
      }
    }

    // Build message history (Anthropic format)
    const messages: Anthropic.MessageParam[] = params.history.map((m) => ({
      role: m.role === "human" ? "user" : "assistant",
      content: m.text,
    }));
    messages.push({ role: "user", content: params.userText });

    const response = await this.client.messages.create({
      model: this.config.model ?? "claude-sonnet-4-6",
      max_tokens: this.config.maxTokens ?? 512,
      system: systemPrompt,
      tools: [RESPOND_TOOL],
      tool_choice: { type: "tool", name: RESPOND_TOOL_NAME },
      messages,
    });

    const durationMs = Date.now() - startedAt;
    const toolBlock = response.content.find((b) => b.type === "tool_use") as
      | Anthropic.ToolUseBlock
      | undefined;

    if (!toolBlock) {
      throw new Error("Claude did not return a tool_use block");
    }

    const input = toolBlock.input as {
      reply: string;
      action: { type: string; to?: string; data?: Record<string, unknown> };
    };

    const action = this.parseAction(input.action);

    return {
      response: { reply: input.reply, action },
      durationMs,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }

  private parseAction(raw: {
    type: string;
    to?: string;
    data?: Record<string, unknown>;
  }): LlmTurnResponse["action"] {
    switch (raw.type) {
      case "end_call":   return { type: "end_call" };
      case "escalate":   return raw.to ? { type: "escalate", to: raw.to } : { type: "escalate" };
      case "capture":    return { type: "capture", data: raw.data ?? {} };
      default:           return { type: "continue" };
    }
  }

  private stubResponse(userText: string): {
    response: LlmTurnResponse;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
  } {
    const lowerText = userText.toLowerCase();
    let reply: string;
    let action: LlmTurnResponse["action"];

    if (lowerText.includes("não") && (lowerText.includes("contacta") || lowerText.includes("ligar"))) {
      reply = "Compreendo perfeitamente. Vou registar o seu pedido de não ser contactado. Tenha um bom dia.";
      action = { type: "end_call" };
    } else if (lowerText.includes("obrigad") || lowerText.includes("tchau") || lowerText.includes("até logo")) {
      reply = "Obrigado pelo seu contacto. Tenha um excelente dia!";
      action = { type: "end_call" };
    } else if (lowerText.includes("humano") || lowerText.includes("atendente") || lowerText.includes("pessoa")) {
      reply = "Claro, vou transferi-lo para um dos nossos atendentes. Um momento, por favor.";
      action = { type: "escalate" };
    } else if (lowerText.includes("confirmo") || lowerText.includes("sim") || lowerText.includes("concordo")) {
      reply = "Excelente! O pagamento foi registado com sucesso. Enviaremos a confirmação por mensagem. Obrigado!";
      action = { type: "capture", data: { confirmed: true, userText } };
    } else {
      reply = "Entendi a sua situação. Posso ajudá-lo a regularizar em condições flexíveis. Tem disponibilidade para efectuar o pagamento esta semana?";
      action = { type: "continue" };
    }

    return {
      response: { reply, action },
      durationMs: 120,
      inputTokens: 150,
      outputTokens: 60,
    };
  }

  async healthCheck(): Promise<{ ok: boolean; details?: string }> {
    if (this.config.stubMode) return { ok: true, details: "stub mode" };
    try {
      const response = await this.client.messages.create({
        model: this.config.model ?? "claude-sonnet-4-6",
        max_tokens: 10,
        messages: [{ role: "user", content: "ping" }],
      });
      return { ok: !!response.id, details: "connected" };
    } catch (err) {
      return { ok: false, details: String(err) };
    }
  }
}
