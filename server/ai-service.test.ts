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

vi.mock("./utils/logger", () => ({
  logger: vi.fn(() => log),
}));

const completion = (content: string | null, usage?: { prompt_tokens: number; completion_tokens: number }) => ({
  choices: [{ message: { content } }],
  usage,
});

describe("AIService", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("XAI_API_KEY", "unit-test-xai-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("constructs the xAI client with the configured test key", async () => {
    const { AIService } = await import("./ai-service");
    const service = new AIService();

    expect(service.isAvailable()).toBe(true);
    expect(openAIConstructor).toHaveBeenCalledWith({
      baseURL: "https://api.x.ai/v1",
      apiKey: "unit-test-xai-key",
    });
  });

  it("does not construct a client when the key is missing", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    const { AIService } = await import("./ai-service");
    openAIConstructor.mockClear(); // Ignore the module's exported singleton.
    const service = new AIService();

    expect(service.isAvailable()).toBe(false);
    expect(openAIConstructor).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      "[AI Service] XAI_API_KEY not found - AI features will be disabled",
    );
    await expect(service.generateContent("hello")).rejects.toThrow(
      "AI service is not available - XAI_API_KEY not configured",
    );
  });

  it("generates trimmed text with the exact prompt, model, temperature, and token bound", async () => {
    createCompletion.mockResolvedValue(completion("  Generated answer  "));
    const { AIService } = await import("./ai-service");
    const service = new AIService();

    await expect(
      service.generateContent("Write it", { customer: "Ada", count: 2 }),
    ).resolves.toBe("Generated answer");
    expect(createCompletion).toHaveBeenCalledWith({
      model: "grok-4.7",
      messages: [
        {
          role: "system",
          content:
            'You are an AI assistant helping with business automation. Here is the context:\n\ncustomer: "Ada"\ncount: 2',
        },
        { role: "user", content: "Write it" },
      ],
      temperature: 0.7,
      max_tokens: 1000,
    });
  });

  it("requests JSON with defaults and returns empty output plus usage defaults", async () => {
    createCompletion.mockResolvedValue({ choices: [], usage: undefined });
    const { AIService } = await import("./ai-service");
    const service = new AIService();

    const result = await service.generateJson({
      systemPrompt: "Return JSON",
      userPrompt: "Analyze this",
    });

    expect(createCompletion).toHaveBeenCalledWith({
      model: "grok-4.7",
      messages: [
        { role: "system", content: "Return JSON" },
        { role: "user", content: "Analyze this" },
      ],
      temperature: 0.2,
      max_tokens: 600,
      response_format: { type: "json_object" },
    });
    expect(result).toMatchObject({
      content: "",
      promptTokens: 0,
      completionTokens: 0,
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("honors explicit JSON temperature/token bounds and reports usage", async () => {
    createCompletion.mockResolvedValue(
      completion('  {"ok":true} ', { prompt_tokens: 11, completion_tokens: 7 }),
    );
    const { AIService } = await import("./ai-service");
    const service = new AIService();

    const result = await service.generateJson({
      systemPrompt: "system",
      userPrompt: "user",
      temperature: 0,
      maxTokens: 42,
    });

    expect(createCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0, max_tokens: 42 }),
    );
    expect(result).toMatchObject({
      content: '{"ok":true}',
      promptTokens: 11,
      completionTokens: 7,
    });
  });

  it("parses analysis JSON and clamps no values beyond existing fallback behavior", async () => {
    createCompletion.mockResolvedValue(
      completion('{"result":"positive","confidence":87,"details":{"reason":"clear"}}'),
    );
    const { AIService } = await import("./ai-service");
    const service = new AIService();

    await expect(service.analyzeData({ note: "great" }, "sentiment")).resolves.toEqual({
      result: "positive",
      confidence: 87,
      details: { reason: "clear" },
    });
    expect(createCompletion).toHaveBeenCalledWith({
      model: "grok-4.7",
      messages: [
        {
          role: "system",
          content:
            "You are a data analysis assistant. Always respond with valid JSON only, no additional text.",
        },
        {
          role: "user",
          content:
            'Analyze the sentiment of this data and return a JSON object with: {"result": "positive|negative|neutral", "confidence": 0-100, "details": {"reason": "explanation"}}.\n\nData:\n{\n  "note": "great"\n}',
        },
      ],
      temperature: 0.3,
      max_tokens: 500,
      response_format: { type: "json_object" },
    });
  });

  it("preserves degraded analysis behavior for malformed and empty output", async () => {
    createCompletion
      .mockResolvedValueOnce(completion("not-json"))
      .mockResolvedValueOnce(completion(""));
    const { AIService } = await import("./ai-service");
    const service = new AIService();

    await expect(service.analyzeData({}, "general")).resolves.toEqual({
      result: "not-json",
      confidence: 50,
      details: { raw: "not-json" },
    });
    await expect(service.analyzeData({})).resolves.toEqual({
      result: "unknown",
      confidence: 50,
      details: {},
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("wraps text and analysis API failures and logs them", async () => {
    const apiError = new Error("network down");
    createCompletion.mockRejectedValue(apiError);
    const { AIService } = await import("./ai-service");
    const service = new AIService();

    await expect(service.generateContent("hello")).rejects.toThrow(
      "Failed to generate content: network down",
    );
    await expect(service.analyzeData({})).rejects.toThrow(
      "Failed to analyze data: network down",
    );
    expect(log.error).toHaveBeenCalledTimes(2);
  });

  it("handles JSON and text email output and enforces the SMS 160-character bound", async () => {
    const { AIService } = await import("./ai-service");
    const service = new AIService();
    const generate = vi.spyOn(service, "generateContent");
    generate
      .mockResolvedValueOnce('{"subject":"Visit","body":"See you soon"}')
      .mockResolvedValueOnce("Plain email")
      .mockResolvedValueOnce("x".repeat(200));

    await expect(service.generateEmail("follow-up", { name: "Ada" })).resolves.toEqual({
      subject: "Visit",
      body: "See you soon",
    });
    await expect(service.generateEmail("reminder", {})).resolves.toEqual({
      subject: "Re: reminder",
      body: "Plain email",
    });
    await expect(service.generateSMS("reminder", {})).resolves.toBe("x".repeat(160));
    expect(generate).toHaveBeenLastCalledWith(
      "Generate a brief SMS text message (max 160 characters) for: reminder\n\nContext:\n\n\nKeep it professional and concise.",
      {},
    );
  });
});