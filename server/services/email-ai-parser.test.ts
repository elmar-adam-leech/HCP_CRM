import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createCompletion, openAIConstructor, log } = vi.hoisted(() => ({
  createCompletion: vi.fn(),
  openAIConstructor: vi.fn(),
  log: { warn: vi.fn(), error: vi.fn() },
}));

vi.mock("openai", () => ({
  default: vi.fn(function (this: any, options: unknown) {
    openAIConstructor(options);
    this.chat = { completions: { create: createCompletion } };
  }),
}));

vi.mock("../utils/logger", () => ({
  logger: vi.fn(() => log),
}));

const response = (content: string | null, finishReason = "stop") => ({
  choices: [{ message: { content }, finish_reason: finishReason }],
});

describe("parseEmailWithAI", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("XAI_API_KEY", "unit-test-xai-key");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("uses the exact xAI request and limits the email body to 3000 characters", async () => {
    createCompletion.mockResolvedValue(
      response(
        '```json\n{"isSpam":false,"spamConfidence":12.6,"name":"Ada Lovelace","phone":null,"email":"ada@example.com","serviceDescription":"AC repair"}\n```',
      ),
    );
    const { parseEmailWithAI } = await import("./email-ai-parser");
    const body = "b".repeat(3010);

    await expect(parseEmailWithAI("Need service", body)).resolves.toEqual({
      status: "success",
      isSpam: false,
      spamConfidence: 13,
      name: "Ada Lovelace",
      phone: undefined,
      email: "ada@example.com",
      serviceDescription: "AC repair",
    });
    expect(openAIConstructor).toHaveBeenCalledWith({
      baseURL: "https://api.x.ai/v1",
      apiKey: "unit-test-xai-key",
    });
    const request = createCompletion.mock.calls[0][0];
    expect(request).toMatchObject({
      model: "grok-4.6",
      temperature: 0.1,
      max_tokens: 500,
    });
    expect(request.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("Respond with valid JSON only, no markdown formatting:"),
    });
    expect(request.messages[1]).toEqual({
      role: "user",
      content: `Subject: Need service\n\nBody:\n${"b".repeat(3000)}`,
    });
  });

  it.each([
    [150, 100],
    [-12, 0],
  ])("bounds spam confidence %s to %s", async (input, expected) => {
    createCompletion.mockResolvedValue(
      response(JSON.stringify({ isSpam: true, spamConfidence: input })),
    );
    const { parseEmailWithAI } = await import("./email-ai-parser");

    await expect(parseEmailWithAI("subject", "body")).resolves.toMatchObject({
      status: "success",
      isSpam: true,
      spamConfidence: expected,
    });
  });

  it("returns an explicit failure for an empty response", async () => {
    createCompletion.mockResolvedValue(response("   "));
    const { parseEmailWithAI } = await import("./email-ai-parser");

    const result = await parseEmailWithAI("subject", "body");
    expect(result).toEqual({
      status: "failed",
      errorCode: "empty_output",
      message: "Email AI returned an empty response.",
    });
    expect(result).not.toHaveProperty("isSpam");
    expect(log.warn).toHaveBeenCalledWith("Empty AI response");
  });

  it("rejects malformed JSON", async () => {
    createCompletion.mockResolvedValue(response("{bad json"));
    const { parseEmailWithAI } = await import("./email-ai-parser");

    await expect(parseEmailWithAI("subject", "body")).resolves.toEqual({
      status: "failed",
      errorCode: "invalid_output",
      message: "Email AI returned an invalid response.",
    });
  });

  it.each([
    ["null", "null"],
    ["array", "[]"],
    ["missing isSpam", '{"spamConfidence":20}'],
    ["non-boolean isSpam", '{"isSpam":"false"}'],
    ["non-finite confidence", '{"isSpam":false,"spamConfidence":1e400}'],
    ["non-number confidence", '{"isSpam":false,"spamConfidence":"20"}'],
    ["invalid optional field", '{"isSpam":false,"name":42}'],
  ])("rejects invalid output shape: %s", async (_description, content) => {
    createCompletion.mockResolvedValue(response(content));
    const { parseEmailWithAI } = await import("./email-ai-parser");

    const result = await parseEmailWithAI("subject", "body");
    expect(result).toMatchObject({ status: "failed", errorCode: "invalid_output" });
    expect(result).not.toHaveProperty("isSpam");
  });

  it("accepts omitted and null optional fields", async () => {
    createCompletion.mockResolvedValue(
      response('{"isSpam":false,"name":null,"phone":null}'),
    );
    const { parseEmailWithAI } = await import("./email-ai-parser");

    await expect(parseEmailWithAI("subject", "body")).resolves.toEqual({
      status: "success",
      isSpam: false,
      spamConfidence: undefined,
      name: undefined,
      phone: undefined,
      email: undefined,
      serviceDescription: undefined,
    });
  });

  it.each([
    ["truncated JSON", '{"isSpam":'],
    ["valid JSON", '{"isSpam":false}'],
  ])("rejects length-finished %s", async (_description, content) => {
    createCompletion.mockResolvedValue(response(content, "length"));
    const { parseEmailWithAI } = await import("./email-ai-parser");

    const result = await parseEmailWithAI("subject", "body");
    expect(result).toEqual({
      status: "failed",
      errorCode: "truncated_output",
      message: "Email AI response was truncated. Please try again.",
    });
    expect(result).not.toHaveProperty("isSpam");
  });

  it("returns an API failure and recovers on a subsequent request", async () => {
    createCompletion
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(response('{"isSpam":true,"email":"lead@example.com"}'));
    const { parseEmailWithAI } = await import("./email-ai-parser");

    const failed = await parseEmailWithAI("subject", "body");
    expect(failed).toEqual({
      status: "failed",
      errorCode: "api_error",
      message: "Email AI parsing is temporarily unavailable.",
    });
    expect(failed).not.toHaveProperty("isSpam");
    await expect(parseEmailWithAI("subject", "body")).resolves.toMatchObject({
      status: "success",
      isSpam: true,
      email: "lead@example.com",
    });
  });

  it("skips AI without constructing a client when the key is missing", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    const { parseEmailWithAI } = await import("./email-ai-parser");

    const result = await parseEmailWithAI("subject", "body");
    expect(result).toEqual({
      status: "failed",
      errorCode: "missing_credentials",
      message: "Email AI parsing is unavailable because credentials are not configured.",
    });
    expect(result).not.toHaveProperty("isSpam");
    expect(openAIConstructor).not.toHaveBeenCalled();
    expect(createCompletion).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      "XAI_API_KEY not configured, skipping AI parsing",
    );
  });

  it("checks credentials before reusing a cached client and recovers when restored", async () => {
    createCompletion.mockResolvedValue(response('{"isSpam":false}'));
    const { parseEmailWithAI } = await import("./email-ai-parser");

    await expect(parseEmailWithAI("subject", "body")).resolves.toMatchObject({
      status: "success",
    });
    vi.stubEnv("XAI_API_KEY", "");
    await expect(parseEmailWithAI("subject", "body")).resolves.toMatchObject({
      status: "failed",
      errorCode: "missing_credentials",
    });
    expect(createCompletion).toHaveBeenCalledTimes(1);

    vi.stubEnv("XAI_API_KEY", "unit-test-xai-key");
    await expect(parseEmailWithAI("subject", "body")).resolves.toMatchObject({
      status: "success",
      isSpam: false,
    });
    expect(createCompletion).toHaveBeenCalledTimes(2);
  });
});