import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

/**
 * O adaptador fala por `node:https`/`node:http` (e não por `fetch`) para poder
 * instalar o `safeLookup` que fecha o DNS rebinding. Por isso estes testes
 * correm contra um servidor HTTP a sério em 127.0.0.1, em vez de mocar a rede:
 * cobrem o caminho verdadeiro — estado, corpo, redirecções, timeout, tamanho.
 *
 * Só o urlGuard é mocado, e apenas para deixar chegar a 127.0.0.1 (que em
 * produção é correctamente recusado). O urlGuard tem os seus 19 testes próprios.
 */
vi.mock("./urlGuard.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./urlGuard.js")>();
  return {
    ...real,
    assertSafeEndpointUrl: (raw: string) => {
      // Deixa passar o servidor de teste; para o resto, o guard verdadeiro.
      if (raw.startsWith("http://127.0.0.1:")) return new URL(raw);
      return real.assertSafeEndpointUrl(raw);
    },
    safeLookup: undefined, // usa o lookup por omissão do Node
  };
});

const { RemoteModelAdapter, RemoteModelError } = await import("./RemoteModelAdapter.js");

/** O que o servidor de teste responde no próximo pedido. */
let handler: (req: IncomingMessage, res: ServerResponse) => void;
let server: Server;
let origin = "";
let requests: Array<{ headers: IncomingMessage["headers"]; body: string }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function json(res: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

function makeAdapter(overrides: Record<string, unknown> = {}) {
  requests = [];
  return new RemoteModelAdapter({
    endpointUrl: `${origin}/turn`,
    authType: "NONE",
    timeoutMs: 2000,
    protocol: "FALAI_TURN",
    ...overrides,
  } as ConstructorParameters<typeof RemoteModelAdapter>[0]);
}

const turn = { systemPrompt: "s", history: [], userText: "olá" };

describe("RemoteModelAdapter", () => {
  it("modo stub não toca na rede", async () => {
    const a = makeAdapter({ stubMode: true });
    const r = await a.generateTurnResponse(turn);
    expect(r.response.action.type).toBe("continue");
    expect(requests).toHaveLength(0);
  });

  it("FALAI_TURN devolve reply e action", async () => {
    handler = (_req, res) => json(res, { reply: "Bom dia!", action: { type: "continue" } });
    const a = makeAdapter();
    const r = await a.generateTurnResponse(turn);
    expect(r.response).toEqual({ reply: "Bom dia!", action: { type: "continue" } });
  });

  it("OPENAI_CHAT mapeia o histórico e lê o usage", async () => {
    handler = (_req, res) =>
      json(res, {
        choices: [{ message: { content: "Bom dia!" } }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      });
    const a = makeAdapter({ protocol: "OPENAI_CHAT", modelName: "gpt-x", signingSecret: "s3cr3t" });
    const r = await a.generateTurnResponse({ ...turn, history: [{ role: "agent", text: "oi" }] });

    expect(r.response).toEqual({ reply: "Bom dia!", action: { type: "continue" } });
    expect(r.inputTokens).toBe(12);

    const sent = requests[0]!;
    expect(sent.headers["x-falai-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(JSON.parse(sent.body).messages[1]).toEqual({ role: "assistant", content: "oi" });
  });

  it("aceita JSON embrulhado em cerca de código", async () => {
    handler = (_req, res) =>
      json(res, {
        choices: [{ message: { content: '```json\n{"reply":"Adeus","action":{"type":"end_call"}}\n```' } }],
      });
    const a = makeAdapter({ protocol: "OPENAI_CHAT", modelName: "gpt-x" });
    const r = await a.generateTurnResponse(turn);
    expect(r.response.action.type).toBe("end_call");
  });

  it("BEARER envia o cabeçalho de autorização", async () => {
    handler = (_req, res) => json(res, { reply: "ok", action: { type: "continue" } });
    const a = makeAdapter({ authType: "BEARER", authSecret: "tok_123" });
    await a.generateTurnResponse(turn);
    expect(requests[0]!.headers.authorization).toBe("Bearer tok_123");
  });

  it("HEADER envia o cabeçalho com o nome configurado", async () => {
    handler = (_req, res) => json(res, { reply: "ok", action: { type: "continue" } });
    const a = makeAdapter({ authType: "HEADER", authHeaderName: "X-Api-Key", authSecret: "k_123" });
    await a.generateTurnResponse(turn);
    expect(requests[0]!.headers["x-api-key"]).toBe("k_123");
  });

  it("HTTP 500 dá code HTTP com o estado", async () => {
    handler = (_req, res) => json(res, { erro: "rebentou" }, 500);
    const a = makeAdapter();
    await expect(a.generateTurnResponse(turn)).rejects.toMatchObject({ code: "HTTP", httpStatus: 500 });
  });

  // Sem isto, um endpoint público que devolvesse 302 para um endereço interno
  // contornava a defesa anti-SSRF inteira.
  it("não segue redirecções", async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    };
    const a = makeAdapter();
    await expect(a.generateTurnResponse(turn)).rejects.toMatchObject({ code: "HTTP", httpStatus: 302 });
  });

  it("resposta que não é JSON dá code CONTRACT", async () => {
    handler = (_req, res) => { res.writeHead(200); res.end("isto não é json"); };
    const a = makeAdapter();
    await expect(a.generateTurnResponse(turn)).rejects.toMatchObject({ code: "CONTRACT" });
  });

  it("JSON válido mas fora do contrato dá CONTRACT, e 3 falhas abrem o disjuntor", async () => {
    handler = (_req, res) => json(res, { nada: 1 });
    const a = makeAdapter();

    for (let i = 0; i < 3; i++) {
      await expect(a.generateTurnResponse(turn)).rejects.toMatchObject({ code: "CONTRACT" });
    }
    // A quarta falha sem tocar na rede: o disjuntor está aberto.
    await expect(a.generateTurnResponse(turn)).rejects.toMatchObject({ code: "HTTP" });
    expect(requests).toHaveLength(3);
  });

  it("corta ao timeout em vez de esperar", async () => {
    handler = () => { /* nunca responde */ };
    const a = makeAdapter({ timeoutMs: 100 });
    await expect(a.generateTurnResponse(turn)).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("recusa um URL interno antes de sair para a rede", async () => {
    const a = makeAdapter({ endpointUrl: "https://169.254.169.254/" });
    await expect(a.generateTurnResponse(turn)).rejects.toBeInstanceOf(RemoteModelError);
    expect(requests).toHaveLength(0);
  });

  it("trunca sem cortar uma palavra a meio", async () => {
    handler = (_req, res) => json(res, { reply: "palavra ".repeat(40), action: { type: "continue" } });
    const a = makeAdapter({ maxReplyChars: 50 });
    const r = await a.generateTurnResponse(turn);
    expect(r.response.reply.length).toBeLessThanOrEqual(51);
    expect(r.response.reply.endsWith("palavra…")).toBe(true);
  });

  it("healthCheck mede a latência sem gastar o disjuntor", async () => {
    handler = (_req, res) => json(res, { reply: "olá", action: { type: "continue" } });
    const a = makeAdapter();
    const health = await a.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.details).toMatch(/ms/);
  });
});
