import OpenAI from "openai";
import { logger } from "../utils/logger";

const log = logger('AIMonitor');

// xAI API configuration - uses same interface as OpenAI
const grok = new OpenAI({ 
  baseURL: "https://api.x.ai/v1", 
  apiKey: process.env.XAI_API_KEY 
});

export interface ErrorAnalysis {
  severity: 'low' | 'medium' | 'high' | 'critical';
  category: string;
  description: string;
  suggestedFix: string;
  confidence: number;
  preventionTips: string[];
}


export class AIMonitorService {
  
  /**
   * Analyze an error using Grok AI to provide intelligent insights
   */
  async analyzeError(error: Error, context?: string): Promise<ErrorAnalysis> {
    try {
      const prompt = `
Analyze this error and provide actionable insights:

Error: ${error.message}
Stack: ${error.stack}
Context: ${context || 'Not provided'}

Provide analysis in JSON format with:
- severity (low/medium/high/critical)
- category (database, api, validation, sync, etc)
- description (clear explanation)
- suggestedFix (specific fix recommendation)
- confidence (0-1 score)
- preventionTips (array of prevention strategies)
`;

      const response = await grok.chat.completions.create({
        model: 'grok-code-fast-1',
        messages: [
          {
            role: "system",
            content: "You are an expert software engineer analyzing errors in a multi-tenant CRM system. Provide practical, actionable insights."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        response_format: { type: "json_object" },
        temperature: 0.3
      });

      return JSON.parse(response.choices[0].message.content || '{}');
    } catch (aiError) {
      log.error('AI error analysis failed', aiError);
      // Fallback analysis
      return {
        severity: 'medium',
        category: 'unknown',
        description: `Error: ${error.message}`,
        suggestedFix: 'Review error logs and stack trace for debugging',
        confidence: 0.1,
        preventionTips: ['Add better error handling', 'Implement monitoring']
      };
    }
  }

}

// Export singleton instance
export const aiMonitor = new AIMonitorService();