import fs from 'node:fs';

const GEMINI_API_KEY = '***REMOVED***';
const DEFAULT_PROJECT_ID = 'project-a06597ee-20ec-4e59-8e7';
const DEFAULT_REGION = 'us-central1';

export function isAIConfigured(): boolean {
    return !!process.env.PORTKEY_API_KEY || fs.existsSync('/Users/nc8/.config/gcloud/application_default_credentials.json');
}

interface PortkeyClient {
    chat: {
        completions: {
            create: (opts: Record<string, unknown>) => Promise<{ choices?: Array<{ message: { content?: string } }> }>
        }
    }
    embeddings: {
        create: (opts: Record<string, unknown>) => Promise<{ data?: Array<{ embedding: number[] }> }>
    }
}

function getPortkeyClient(): PortkeyClient {
    // Dynamic import to avoid crash when portkey-ai is not installed
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const { Portkey } = require('portkey-ai');
    const config = {
        apiKey: process.env.PORTKEY_API_KEY || 'nhHEpfsw5sTpXp1E3PQGDQd03vdN',
        baseURL: process.env.PORTKEY_BASE_URL || 'https://api.portkey.ai/v1',
        vertexProjectId: DEFAULT_PROJECT_ID,
        vertexRegion: DEFAULT_REGION
    };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return new Portkey(config);
}

interface GoogleMessage {
    role: string
    content: string
    tool_calls?: Array<{ function: { name: string; arguments: string } }>
}

interface GoogleFormatResult {
    systemInstruction?: { parts: Array<{ text: string }> }
    contents: Array<Record<string, unknown>>
}

function convertMessagesToGoogleFormat(messages: GoogleMessage[]): GoogleFormatResult {
    let systemInstruction: { parts: Array<{ text: string }> } | undefined;
    const contents: Array<Record<string, unknown>> = [];

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

async function getADCAccessToken(): Promise<{ accessToken: string; projectId: string }> {
    const credsPath = '/Users/nc8/.config/gcloud/application_default_credentials.json';
    if (!fs.existsSync(credsPath)) {
        throw new Error('Local Application Default Credentials (ADC) file not found');
    }
    const creds: { client_id: string; client_secret: string; refresh_token: string; quota_project_id?: string } = JSON.parse(fs.readFileSync(credsPath, 'utf8'));

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

    const data = await res.json() as { access_token: string };
    return {
        accessToken: data.access_token,
        projectId: creds.quota_project_id || DEFAULT_PROJECT_ID
    };
}

async function callDirectVertexAI(modelName: string, messages: GoogleMessage[], options: Record<string, unknown> = {}): Promise<string> {
    const { accessToken, projectId } = await getADCAccessToken();
    const region = DEFAULT_REGION;

    const { systemInstruction, contents } = convertMessagesToGoogleFormat(messages);

    const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${modelName}:generateContent`;

    const body: Record<string, unknown> = {
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

    const data = await res.json() as { candidates?: Array<{ content: { parts: Array<{ text?: string }> } }> };
    if (data.candidates && data.candidates.length > 0) {
        return data.candidates[0].content.parts[0].text || '';
    }
    throw new Error('Invalid response structure from direct Vertex AI REST call');
}

async function callDirectAIStudio(modelName: string, messages: GoogleMessage[], options: Record<string, unknown> = {}): Promise<string> {
    const { systemInstruction, contents } = convertMessagesToGoogleFormat(messages);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;

    const body: Record<string, unknown> = {
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

    const data = await res.json() as { candidates?: Array<{ content: { parts: Array<{ text?: string }> } }> };
    if (data.candidates && data.candidates.length > 0) {
        return data.candidates[0].content.parts[0].text || '';
    }
    throw new Error('Invalid response structure from direct AI Studio REST call');
}

export async function chatCompletion(messages: GoogleMessage[], options: Record<string, unknown> = {}): Promise<string> {
    const modelName = process.env.AI_MODEL || 'gemini-3.1-flash-lite';
    const rawModelName = modelName.replace(/^@vertex-ai\//, '').replace(/^google\//, '');

    try {
        console.log(`[AI] Attempting direct Google AI Studio for ${rawModelName}...`);
        return await callDirectAIStudio(rawModelName, messages, options);
    } catch (err) {
        console.warn(`[AI] Direct Google AI Studio failed: ${(err as Error).message}. Trying direct Vertex AI REST with ADC...`);
    }

    try {
        console.log(`[AI] Attempting direct Google Vertex AI REST with ADC for ${rawModelName}...`);
        return await callDirectVertexAI(rawModelName, messages, options);
    } catch (err) {
        console.warn(`[AI] Direct Google Vertex AI REST with ADC failed: ${(err as Error).message}. Trying Portkey...`);
    }

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

export async function createEmbedding(text: string): Promise<number[]> {
    const modelName = process.env.AI_EMBEDDING_MODEL || 'gemini-embedding-2';
    const rawModelName = modelName.replace(/^@vertex-ai\//, '').replace(/^google\//, '');

    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent?key=${GEMINI_API_KEY}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                content: { parts: [{ text }] }
            })
        });

        if (res.ok) {
            const data = await res.json() as { embedding?: { values?: number[] } };
            if (data.embedding && data.embedding.values) {
                return data.embedding.values;
            }
        }
    } catch (err) {
        console.warn(`[AI] Direct AI Studio embedding failed: ${(err as Error).message}. Trying Portkey...`);
    }

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
