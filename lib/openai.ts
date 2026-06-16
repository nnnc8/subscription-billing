import fs from 'node:fs';

export function isAIConfigured(): boolean {
    return !!process.env.OPENAI_API_KEY;
}

interface OpenAIClient {
    chat: {
        completions: {
            create: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>
        }
    }
    embeddings: {
        create: (opts: Record<string, unknown>) => Promise<{ data?: Array<{ embedding: number[] }> }>
    }
}

function getOpenAIClient(): OpenAIClient {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { OpenAI } = require('openai');
    const config = {
        apiKey: process.env.OPENAI_API_KEY || 'your-openai-api-key-here',
        baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
    };
    return new OpenAI(config) as unknown as OpenAIClient;
}

interface AiMessage {
    role: string
    content: string
    tool_calls?: Array<{ function: { name: string; arguments: string } }>
}

function convertMessagesToOpenAIFormat(messages: AiMessage[]): { systemInstruction?: string; contents: Array<Record<string, unknown>> } {
    let systemInstruction: string | undefined;
    const contents: Array<Record<string, unknown>> = [];

    messages.forEach(msg => {
        if (msg.role === 'system') {
            systemInstruction = msg.content;
        } else if (msg.role === 'user') {
            contents.push({
                role: 'user',
                content: msg.content
            });
        } else if (msg.role === 'tool') {
            contents.push({
                role: 'user',
                content: `【工具執行結果】：\n${msg.content}`
            });
        } else if (msg.role === 'assistant') {
            let textContent = msg.content || '';
            if (msg.tool_calls && msg.tool_calls.length > 0) {
                const toolCallsDesc = msg.tool_calls.map(tc => {
                    return `${tc.function.name}(${tc.function.arguments || ''})`;
                }).join(', ');
                textContent += `\n【系統工具呼叫】執行：${toolCallsDesc}`;
            }
            contents.push({
                role: 'assistant',
                content: textContent.trim()
            });
        }
    });

    return { systemInstruction, contents };
}

export async function callOpenAIWithTools(modelName: string, messages: AiMessage[], tools: Record<string, unknown>[], options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const openaiClient = getOpenAIClient();

    const { systemInstruction, contents } = convertMessagesToOpenAIFormat(messages);

    const body: Record<string, unknown> = {
        model: modelName,
        messages: contents,
        tools: tools,
        tool_choice: 'auto',
        temperature: options.temperature ?? 0.7,
        max_tokens: options.max_tokens ?? 2000
    };

    if (systemInstruction) {
        body.system = systemInstruction;
    }

    const res = await openaiClient.chat.completions.create(body);
    return res;
}

export async function callOpenAIText(modelName: string, messages: AiMessage[], options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const openaiClient = getOpenAIClient();

    const { systemInstruction, contents } = convertMessagesToOpenAIFormat(messages);

    const body: Record<string, unknown> = {
        model: modelName,
        messages: contents,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.max_tokens ?? 2000
    };

    if (systemInstruction) {
        body.system = systemInstruction;
    }

    const res = await openaiClient.chat.completions.create(body);
    return res;
}

export async function createOpenAIEmbedding(text: string): Promise<number[]> {
    const openaiClient = getOpenAIClient();

    const response = await openaiClient.embeddings.create({
        model: 'text-embedding-3-small',
        input: text,
        encoding_format: 'float'
    });

    return response.data![0].embedding;
}

export function cosineSimilarity(a: number[], b: number[]): number {
    if (!a || !b || a.length !== b.length) {
        return 0;
    }
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) {
        return 0;
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
