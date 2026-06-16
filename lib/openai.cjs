"use strict";

const fs = require('fs');

/**
 * Checks if the API Key is configured in the environment.
 * @returns {boolean}
 */
function isAIConfigured() {
    return !!process.env.OPENAI_API_KEY;
}

/**
 * Returns OpenAI client for backward compatibility.
 * @returns {OpenAI}
 */
function getOpenAIClient() {
    const { OpenAI } = require('openai');
    const config = {
        apiKey: process.env.OPENAI_API_KEY || 'your-openai-api-key-here',
        baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
    };
    return new OpenAI(config);
}

/**
 * Helper to convert OpenAI messages to the format expected by the API.
 */
function convertMessagesToOpenAIFormat(messages) {
    let systemInstruction = undefined;
    const contents = [];

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

/**
 * Calls OpenAI Chat Completions API with full function-calling support.
 */
async function callOpenAIWithTools(modelName, messages, tools, options = {}) {
    const openaiClient = getOpenAIClient();
    
    const { systemInstruction, contents } = convertMessagesToOpenAIFormat(messages);

    const body = {
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

/**
 * Calls OpenAI Completions API for text generation.
 */
async function callOpenAIText(modelName, messages, options = {}) {
    const openaiClient = getOpenAIClient();
    
    const { systemInstruction, contents } = convertMessagesToOpenAIFormat(messages);

    const body = {
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

/**
 * Generates an embedding vector using OpenAI API.
 */
async function createOpenAIEmbedding(text) {
    const openaiClient = getOpenAIClient();
    
    const response = await openaiClient.embeddings.create({
        model: 'text-embedding-3-small',
        input: text,
        encoding_format: 'float'
    });

    return response.data[0].embedding;
}

/**
 * Computes cosine similarity between two vectors.
 * @param {Array<number>} a 
 * @param {Array<number>} b 
 * @returns {number}
 */
function cosineSimilarity(a, b) {
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

module.exports = {
    isAIConfigured,
    getOpenAIClient,
    callOpenAIWithTools,
    callOpenAIText,
    createOpenAIEmbedding,
    cosineSimilarity
};