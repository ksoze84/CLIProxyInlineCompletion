import { ExtensionConfig } from './config';

export interface CompletionRequest {
	languageId: string;
	fileName: string;
	prefix: string;
	suffix: string;
}

export class CliProxyError extends Error {
	constructor(message: string, readonly status?: number) {
		super(message);
		this.name = 'CliProxyError';
	}
}

const SYSTEM_PROMPT = [
	'You are a code completion engine integrated into an editor.',
	'You receive a code file split by the cursor position into <|prefix|> and <|suffix|>.',
	'Reply with the raw text that must be inserted at the cursor so the file becomes valid.',
	'Rules:',
	'- Output only the inserted code, nothing else.',
	'- Never repeat the prefix or the suffix.',
	'- Never wrap the answer in markdown code fences.',
	'- Never add explanations, comments about the task, or trailing prose.',
	'- If no completion is appropriate, reply with an empty string.'
].join('\n');

function buildMessages(config: ExtensionConfig, request: CompletionRequest): Array<{ role: string; content: string }> {
	const system = config.systemPrompt ? `${SYSTEM_PROMPT}\n${config.systemPrompt}` : SYSTEM_PROMPT;
	const user = [
		`File: ${request.fileName}`,
		`Language: ${request.languageId}`,
		'',
		'<|prefix|>',
		request.prefix,
		'<|suffix|>',
		request.suffix
	].join('\n');
	return [
		{ role: 'system', content: system },
		{ role: 'user', content: user }
	];
}

async function postJson(config: ExtensionConfig, path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (config.apiKey) {
		headers['Authorization'] = `Bearer ${config.apiKey}`;
	}

	const response = await fetch(`${config.baseUrl}${path}`, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
		signal
	});

	if (!response.ok) {
		const detail = (await response.text()).slice(0, 500);
		throw new CliProxyError(`CLIProxyApi returned ${response.status}: ${detail}`, response.status);
	}
	return response.json();
}

function extractContent(payload: unknown): string {
	const choice = (payload as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0];
	const content = choice?.message?.content;
	if (typeof content === 'string') {
		return content;
	}
	// Some providers return content as an array of typed parts.
	if (Array.isArray(content)) {
		return content
			.map(part => (typeof part === 'string' ? part : (part as { text?: string })?.text ?? ''))
			.join('');
	}
	return '';
}

export async function fetchCompletion(
	config: ExtensionConfig,
	request: CompletionRequest,
	signal: AbortSignal
): Promise<string> {
	const payload = await postJson(
		config,
		'/v1/chat/completions',
		{
			model: config.model,
			messages: buildMessages(config, request),
			max_tokens: config.maxTokens,
			temperature: config.temperature,
			stream: false,
			stop: ['<|prefix|>', '<|suffix|>']
		},
		signal
	);
	return extractContent(payload);
}

export async function listModels(config: ExtensionConfig, signal: AbortSignal): Promise<string[]> {
	const headers: Record<string, string> = {};
	if (config.apiKey) {
		headers['Authorization'] = `Bearer ${config.apiKey}`;
	}

	const response = await fetch(`${config.baseUrl}/v1/models`, { headers, signal });
	if (!response.ok) {
		throw new CliProxyError(`CLIProxyApi returned ${response.status}`, response.status);
	}
	const payload = (await response.json()) as { data?: Array<{ id?: string }> };
	return (payload.data ?? []).map(entry => entry.id).filter((id): id is string => typeof id === 'string');
}
