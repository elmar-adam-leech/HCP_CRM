import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createCompletion, openAIConstructor, log } = vi.hoisted(() => ({
  createCompletion: vi.fn(),
  openAIConstructor: vi.fn(),
  log: { error: vi.fn() },
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

const fallback = {
  severity: "medium",
  category: "unknown",
  description: "Error: database unavailable",
  suggestedFix: "Review error logs and stack trace for debugging",
  confidence: 0.1,
  preventionTips: ["Add better error handling", "Implement monitoring"],
};

describe("AIMonitorService", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("XAI_API_KEY", "unit-test-xai-key");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("requests bounded JSON analysis with the exact model, prompts, and temperature", async () => {
    const analysis = {
      severity: "high",
      category: "database",
      description: "Connection failed",
      suggestedFix: "Check the database",
      confidence: 0.9,
      preventionTips: ["Add retries"],
    };
    createCompletion.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(analysis) } }],
    });
    const { AIMonitorService } = await import("./ai-monitor");
    const error = new Error("database unavailable");

    await expect(new AIMonitorService().analyzeError(error, "sync job")).resolves.toEqual(
      analysis,
    );
    expect(openAIConstructor).toHaveBeenCalledWith({
      baseURL: "https://api.x.ai/v1",
      apiKey: "unit-test-xai-key",
    });
    expect(createCompletion).toHaveBeenCalledWith({
      model: "grok-4.7",
      messages: [
        {
          role: "system",
          content:
            "You are an expert software engineer analyzing errors in a multi-tenant CRM system. Provide practical, actionable insights.",
        },
        {
          role: "user",
          content: expect.stringContaining(
            "Error: database unavailable",
          ),
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
    });
    expect(createCompletion.mock.calls[0][0].messages[1].content).toContain(
      "Context: sync job",
    );
    expect(createCompletion.mock.calls[0][0].messages[1].content).toContain(
      "- confidence (0-1 score)",
    );
  });

  it("returns the existing fallback for malformed output", async () => {
    createCompletion.mockResolvedValue({
      choices: [{ message: { content: "not-json" } }],
    });
    const { AIMonitorService } = await import("./ai-monitor");

    await expect(
      new AIMonitorService().analyzeError(new Error("database unavailable")),
    ).resolves.toEqual(fallback);
    expect(log.error).toHaveBeenCalledWith(
      "AI error analysis failed",
      expect.anything(),
    );
  });

  it("preserves the existing empty-object behavior for empty output", async () => {
    createCompletion.mockResolvedValue({
      choices: [{ message: { content: "" } }],
    });
    const { AIMonitorService } = await import("./ai-monitor");

    await expect(
      new AIMonitorService().analyzeError(new Error("database unavailable")),
    ).resolves.toEqual({});
    expect(log.error).not.toHaveBeenCalled();
  });

  it("returns the existing fallback after an API failure", async () => {
    const apiError = new Error("network down");
    createCompletion.mockRejectedValue(apiError);
    const { AIMonitorService } = await import("./ai-monitor");

    await expect(
      new AIMonitorService().analyzeError(new Error("database unavailable")),
    ).resolves.toEqual(fallback);
    expect(log.error).toHaveBeenCalledWith("AI error analysis failed", apiError);
  });

  it("does not read an ambient secret when the key is missing", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    await import("./ai-monitor");

    expect(openAIConstructor).toHaveBeenCalledWith({
      baseURL: "https://api.x.ai/v1",
      apiKey: "",
    });
  });
});