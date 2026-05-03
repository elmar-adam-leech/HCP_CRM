
import { logger } from './utils/logger';

const log = logger('AiService');import OpenAI from 'openai';

/**
 * AI Service for workflow automation
 * Provides AI-powered features for generating content and analyzing data
 * Using xAI (Grok) models
 */
export class AIService {
  private client: OpenAI | null = null;

  constructor() {
    // Initialize xAI (Grok) client if API key is available
    const apiKey = process.env.XAI_API_KEY;
    if (apiKey) {
      this.client = new OpenAI({ 
        baseURL: "https://api.x.ai/v1",
        apiKey 
      });
    } else {
      log.warn('[AI Service] XAI_API_KEY not found - AI features will be disabled');
    }
  }

  /**
   * Check if AI service is available
   */
  isAvailable(): boolean {
    return this.client !== null;
  }

  /**
   * Generate content using AI based on a prompt and context
   * @param prompt - The instruction for what to generate
   * @param context - Additional context data to inform the generation
   * @returns Generated content as a string
   */
  async generateContent(prompt: string, context: Record<string, any> = {}): Promise<string> {
    if (!this.client) {
      throw new Error('AI service is not available - XAI_API_KEY not configured');
    }

    // Build the system message with context
    const contextStr = Object.entries(context)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join('\n');

    const systemMessage = contextStr
      ? `You are an AI assistant helping with business automation. Here is the context:\n\n${contextStr}`
      : 'You are an AI assistant helping with business automation.';

    try {
      const completion = await this.client.chat.completions.create({
        model: 'grok-4-fast-reasoning',
        messages: [
          { role: 'system', content: systemMessage },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 1000
      });

      const content = completion.choices[0]?.message?.content || '';
      return content.trim();
    } catch (error) {
      log.error('[AI Service] Error generating content:', error);
      throw new Error(`Failed to generate content: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Generate a JSON object from the model with `response_format: json_object`
   * enforced. Returns the raw JSON text plus latency/usage stats so callers
   * can log token consumption per-request. Used by structured-output paths
   * like the AI scheduling agent where the response must be parseable JSON.
   */
  async generateJson(opts: {
    systemPrompt: string;
    userPrompt: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ content: string; latencyMs: number; promptTokens: number; completionTokens: number }> {
    if (!this.client) {
      throw new Error('AI service is not available - XAI_API_KEY not configured');
    }
    const startedAt = Date.now();
    const completion = await this.client.chat.completions.create({
      model: 'grok-4-fast-reasoning',
      messages: [
        { role: 'system', content: opts.systemPrompt },
        { role: 'user', content: opts.userPrompt },
      ],
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 600,
      response_format: { type: "json_object" },
    });
    const latencyMs = Date.now() - startedAt;
    return {
      content: (completion.choices[0]?.message?.content || '').trim(),
      latencyMs,
      promptTokens: completion.usage?.prompt_tokens ?? 0,
      completionTokens: completion.usage?.completion_tokens ?? 0,
    };
  }

  /**
   * Analyze data and return structured insights
   * @param data - The data to analyze
   * @param analysisType - Type of analysis to perform (sentiment, priority, category, etc.)
   * @returns Analysis results as a structured object
   */
  async analyzeData(
    data: Record<string, any>,
    analysisType: string = 'general'
  ): Promise<{ result: string; confidence: number; details: Record<string, any> }> {
    if (!this.client) {
      throw new Error('AI service is not available - XAI_API_KEY not configured');
    }

    // Build analysis prompt based on type
    let prompt = '';
    const dataStr = JSON.stringify(data, null, 2);

    switch (analysisType.toLowerCase()) {
      case 'sentiment':
        prompt = `Analyze the sentiment of this data and return a JSON object with: {"result": "positive|negative|neutral", "confidence": 0-100, "details": {"reason": "explanation"}}.\n\nData:\n${dataStr}`;
        break;
      case 'priority':
        prompt = `Analyze the priority level of this data and return a JSON object with: {"result": "high|medium|low", "confidence": 0-100, "details": {"reason": "explanation"}}.\n\nData:\n${dataStr}`;
        break;
      case 'category':
        prompt = `Categorize this data and return a JSON object with: {"result": "category name", "confidence": 0-100, "details": {"reason": "explanation"}}.\n\nData:\n${dataStr}`;
        break;
      default:
        prompt = `Analyze this data and return a JSON object with: {"result": "summary", "confidence": 0-100, "details": {"insights": "key insights"}}.\n\nData:\n${dataStr}`;
    }

    try {
      const completion = await this.client.chat.completions.create({
        model: 'grok-4-fast-reasoning',
        messages: [
          {
            role: 'system',
            content: 'You are a data analysis assistant. Always respond with valid JSON only, no additional text.'
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 500,
        response_format: { type: "json_object" }
      });

      const content = completion.choices[0]?.message?.content || '{}';
      
      try {
        const parsed = JSON.parse(content.trim());
        return {
          result: parsed.result || 'unknown',
          confidence: parsed.confidence || 50,
          details: parsed.details || {}
        };
      } catch (parseError) {
        // The model returned non-JSON despite the json_object response_format directive.
        // Return a degraded response so callers don't crash, but log enough detail
        // for a developer to reproduce the failure (analysisType + raw model output).
        log.warn(
          `[AI Service] Failed to parse AI response for analysisType="${analysisType}". ` +
          `parseError=${parseError instanceof Error ? parseError.message : String(parseError)}. ` +
          `rawContent=${content.substring(0, 500)}`
        );
        return {
          result: content.trim(),
          confidence: 50,
          details: { raw: content }
        };
      }
    } catch (error) {
      log.error('[AI Service] Error analyzing data:', error);
      throw new Error(`Failed to analyze data: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Generate an email based on context and purpose
   * @param purpose - The purpose of the email (follow-up, reminder, etc.)
   * @param context - Context data (lead info, previous communications, etc.)
   * @returns Email with subject and body
   */
  async generateEmail(
    purpose: string,
    context: Record<string, any>
  ): Promise<{ subject: string; body: string }> {
    const contextStr = Object.entries(context)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join('\n');

    const prompt = `Generate a professional email for the following purpose: ${purpose}\n\nContext:\n${contextStr}\n\nReturn a JSON object with "subject" and "body" fields. Keep it concise and professional.`;

    const content = await this.generateContent(prompt, {});

    try {
      // Try to parse as JSON first
      const parsed = JSON.parse(content);
      return {
        subject: parsed.subject || 'No subject',
        body: parsed.body || content
      };
    } catch {
      // If not JSON, treat the whole response as the body
      return {
        subject: `Re: ${purpose}`,
        body: content
      };
    }
  }

  /**
   * Generate SMS text based on context and purpose
   * @param purpose - The purpose of the SMS
   * @param context - Context data
   * @returns SMS message text (max 160 chars)
   */
  async generateSMS(purpose: string, context: Record<string, any>): Promise<string> {
    const contextStr = Object.entries(context)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join('\n');

    const prompt = `Generate a brief SMS text message (max 160 characters) for: ${purpose}\n\nContext:\n${contextStr}\n\nKeep it professional and concise.`;

    const content = await this.generateContent(prompt, {});
    
    // Truncate to 160 chars if needed
    return content.substring(0, 160);
  }
}

// Export singleton instance
export const aiService = new AIService();
