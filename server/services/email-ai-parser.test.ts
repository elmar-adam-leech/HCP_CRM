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

const response = (content: string | null) => ({
  choices: [{ message: { content } }],
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
      isSpam: true,
      spamConfidence: expected,
    });
  });

  it("returns non-spam for an empty response", async () => {
    createCompletion.mockResolvedValue(response("   "));
    const { parseEmailWithAI } = await import("./email-ai-parser");

    await expect(parseEmailWithAI("subject", "body")).resolves.toEqual({ isSpam: false });
    expect(log.warn).toHaveBeenCalledWith("Empty AI response, treating as non-spam");
  });

  it("returns non-spam and logs malformed JSON or API failure", async () => {
    createCompletion
      .mockResolvedValueOnce(response("{bad json"))
      .mockRejectedValueOnce(new Error("network down"));
    const { parseEmailWithAI } = await import("./email-ai-parser");

    await expect(parseEmailWithAI("subject", "body")).resolves.toEqual({ isSpam: false });
    await expect(parseEmailWithAI("subject", "body")).resolves.toEqual({ isSpam: false });
    expect(log.error).toHaveBeenCalledTimes(2);
  });

  it("skips AI without constructing a client when the key is missing", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    const { parseEmailWithAI } = await import("./email-ai-parser");

    await expect(parseEmailWithAI("subject", "body")).resolves.toEqual({ isSpam: false });
    expect(openAIConstructor).not.toHaveBeenCalled();
    expect(createCompletion).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      "XAI_API_KEY not configured, skipping AI parsing",
    );
  });
});