const fs = require('fs');
const os = require('os');
const path = require('path');
const { Portkey } = require('portkey-ai');

const getGeminiApiKey = () => process.env.GOOGLE_GEMINI_API_KEY || '';
const DEFAULT_PROJECT_ID = 'project-a06597ee-20ec-4e59-8e7';
const DEFAULT_REGION = 'us-central1';

/**
 * Checks if the API Key is configured in the environment.
 * @returns {boolean}
 */
function isAIConfigured() {
    return !!process.env.GOOGLE_GEMINI_API_KEY;
}

/**
 * Returns Portkey client for backward compatibility.
 * @returns {Portkey}
 */
function getPortkeyClient() {
    const config = {
        apiKey: process.env.PORTKEY_API_KEY || '',
        baseURL: process.env.PORTKEY_BASE_URL || 'https://api.portkey.ai/v1',
        vertexProjectId: DEFAULT_PROJECT_ID,
        vertexRegion: DEFAULT_REGION
    };
    return new Portkey(config);
}

/**
 * Obtains an OAuth 2.0 access token dynamically using local Application Default Credentials (ADC).
 * @returns {Promise<{accessToken: string, projectId: string}>}
 */
async function getADCAccessToken() {
    const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(os.homedir(), '.config/gcloud/application_default_credentials.json');
    if (!fs.existsSync(credsPath)) {
        throw new Error('Local Application Default Credentials (ADC) file not found');
    }
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    
    const params = new URLSearchParams();
    params.append('client_id', creds.client_id);
    params.append('client_secret', creds.client_secret);
    params.append('refresh_token', creds.refresh_token);
    params.append('grant_type', 'refresh_token');

    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Failed to refresh GCP OAuth token: ${errText}`);
    }

    const data = await res.json();
    return {
        accessToken: data.access_token,
        projectId: creds.quota_project_id || DEFAULT_PROJECT_ID
    };
}

/**
 * Helper to convert OpenAI messages to Google Vertex/AI Studio format.
 */
function convertMessagesToGoogleFormat(messages) {
    let systemInstruction = undefined;
    const contents = [];

    messages.forEach(msg => {
        if (msg.role === 'system') {
            systemInstruction = {
                parts: [{ text: msg.content }]
            };
        } else if (msg.role === 'user') {
            contents.push({
                role: 'user',
                parts: [{ text: msg.content }]
            });
        } else if (msg.role === 'tool') {
            contents.push({
                role: 'user',
                parts: [{ text: `【工具執行結果】：\n${msg.content}` }]
            });
        } else if (msg.role === 'assistant' || msg.role === 'model') {
            let textContent = msg.content || '';
            if (msg.tool_calls && msg.tool_calls.length > 0) {
                const toolCallsDesc = msg.tool_calls.map(tc => {
                    return `${tc.function.name}(${tc.function.arguments || ''})`;
                }).join(', ');
                textContent += `\n【系統工具呼叫】執行：${toolCallsDesc}`;
            }
            contents.push({
                role: 'model',
                parts: [{ text: textContent.trim() }]
            });
        }
    });

    return { systemInstruction, contents };
}

/**
 * Calls direct Google Vertex AI REST API using local ADC credentials.
 */
async function callDirectVertexAI(modelName, messages, options = {}) {
    const { accessToken, projectId } = await getADCAccessToken();
    const region = DEFAULT_REGION;
    
    const { systemInstruction, contents } = convertMessagesToGoogleFormat(messages);

    const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${modelName}:generateContent`;

    const body = {
        contents: contents,
        generationConfig: {
            temperature: options.temperature ?? 0.7,
            maxOutputTokens: options.max_tokens ?? 2000
        }
    };

    if (systemInstruction) {
        body.systemInstruction = systemInstruction;
    }

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Direct Vertex AI REST returned ${res.status}: ${errText}`);
    }

    const data = await res.json();
    if (data.candidates && data.candidates.length > 0) {
        return data.candidates[0].content.parts[0].text || '';
    }
    throw new Error('Invalid response structure from direct Vertex AI REST call');
}

/**
 * Calls direct Google AI Studio REST API using plaintext API key.
 */
async function callDirectAIStudio(modelName, messages, options = {}) {
    const { systemInstruction, contents } = convertMessagesToGoogleFormat(messages);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${getGeminiApiKey()}`;

    const body = {
        contents: contents,
        generationConfig: {
            temperature: options.temperature ?? 0.7,
            maxOutputTokens: options.max_tokens ?? 2000
        }
    };

    if (systemInstruction) {
        body.systemInstruction = systemInstruction;
    }

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Direct AI Studio REST returned ${res.status}: ${errText}`);
    }

    const data = await res.json();
    if (data.candidates && data.candidates.length > 0) {
        return data.candidates[0].content.parts[0].text || '';
    }
    throw new Error('Invalid response structure from direct AI Studio REST call');
}

/**
 * Unified Chat Completion call.
 * Tries Portkey -> falls back to direct Google AI Studio -> falls back to direct Vertex AI REST with ADC.
 * @param {Array<Object>} messages - Array of message objects { role, content }
 * @param {Object} [options] - Additional parameters (temperature, max_tokens, etc.)
 * @returns {Promise<string>} - The assistant's reply content
 */
async function chatCompletion(messages, options = {}) {
    let modelName = process.env.AI_MODEL || 'gemini-3.1-flash-lite';
    // Normalize model name
    const rawModelName = modelName.replace(/^@vertex-ai\//, '').replace(/^google\//, '');
    
    // 1. First try direct AI Studio endpoint (most reliable in sandbox)
    try {
        console.log(`[AI] Attempting direct Google AI Studio for ${rawModelName}...`);
        return await callDirectAIStudio(rawModelName, messages, options);
    } catch (err) {
        console.warn(`[AI] Direct Google AI Studio failed: ${err.message}. Trying direct Vertex AI REST with ADC...`);
    }

    // 2. Next try direct Vertex AI REST using GCP local ADC
    try {
        console.log(`[AI] Attempting direct Google Vertex AI REST with ADC for ${rawModelName}...`);
        return await callDirectVertexAI(rawModelName, messages, options);
    } catch (err) {
        console.warn(`[AI] Direct Google Vertex AI REST with ADC failed: ${err.message}. Trying Portkey...`);
    }

    // 3. Fallback to Portkey integration
    const portkeyClient = getPortkeyClient();
    try {
        console.log(`[AI] Attempting Portkey call for ${modelName}...`);
        const response = await portkeyClient.chat.completions.create({
            model: modelName,
            messages: messages,
            temperature: options.temperature ?? 0.7,
            max_tokens: options.max_tokens ?? 2000,
            ...options
        });

        if (response && response.choices && response.choices.length > 0) {
            return response.choices[0].message.content || '';
        }
        throw new Error('Invalid response structure from Portkey API');
    } catch (err) {
        console.error('[AI] All completion methods (Portkey, AI Studio, Vertex REST) failed:', err);
        throw err;
    }
}

/**
 * Generates an embedding vector.
 * Tries direct Google AI Studio embedding -> falls back to Portkey embedding.
 * @param {string} text - The input text to embed
 * @returns {Promise<Array<number>>} - Vector array
 */
async function createEmbedding(text) {
    let modelName = process.env.AI_EMBEDDING_MODEL || 'gemini-embedding-2';
    const rawModelName = modelName.replace(/^@vertex-ai\//, '').replace(/^google\//, '');

    // 1. Try direct Google AI Studio embedding endpoint
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${rawModelName}:embedContent?key=${getGeminiApiKey()}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                content: { parts: [{ text: text }] }
            })
        });

        if (res.ok) {
            const data = await res.json();
            if (data.embedding && data.embedding.values) {
                return data.embedding.values;
            }
        }
    } catch (err) {
        console.warn(`[AI] Direct AI Studio embedding failed: ${err.message}. Trying Portkey...`);
    }

    // 2. Fallback to Portkey
    const portkeyClient = getPortkeyClient();
    try {
        const response = await portkeyClient.embeddings.create({
            model: modelName,
            input: text
        });

        if (response && response.data && response.data.length > 0) {
            return response.data[0].embedding;
        }
        throw new Error('Invalid response structure from Portkey Embedding API');
    } catch (err) {
        console.error('[AI] Embedding generation failed across all methods:', err);
        throw err;
    }
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
    getPortkeyClient,
    chatCompletion,
    createEmbedding,
    cosineSimilarity
};
