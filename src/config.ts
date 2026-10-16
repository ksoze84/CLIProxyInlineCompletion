import * as vscode from 'vscode';
import { isSensitivePath } from './textContext';

export const CONFIG_SECTION = 'cliproxyInline';

/**
 * Reasoning effort levels accepted by OpenAI-compatible `reasoning_effort`.
 * An empty string means "omit the parameter" (server default).
 */
export const REASONING_EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high'] as const;

export type ReasoningEffort = typeof REASONING_EFFORT_LEVELS[number] | '';

export interface ExtensionConfig {
	enabled: boolean;
	baseUrl: string;
	apiKey: string;
	model: string;
	reasoningEffort: ReasoningEffort;
	maxTokens: number;
	temperature: number;
	debounceMs: number;
	requestTimeoutMs: number;
	prefixLines: number;
	suffixLines: number;
	languages: string[];
	systemPrompt: string;
	nextEditsEnabled: boolean;
	nextEditsAutomatic: boolean;
	nextEditsTabNavigation: boolean;
}

function bounded(value: number, fallback: number, minimum: number, maximum: number): number {
	return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

function baseUrl(value: string): string {
	let end = value.length;
	while (end > 0 && value[end - 1] === '/') {
		end--;
	}
	return value.slice(0, end);
}

export function parseReasoningEffort(value: unknown): ReasoningEffort {
	return typeof value === 'string' && (REASONING_EFFORT_LEVELS as readonly string[]).includes(value)
		? value as ReasoningEffort
		: '';
}

export function getConfig(): ExtensionConfig {
	const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return {
		enabled: cfg.get<boolean>('enabled', true),
		baseUrl: baseUrl(cfg.get<string>('baseUrl', 'http://127.0.0.1:8317')),
		apiKey: cfg.get<string>('apiKey', '').trim(),
		model: cfg.get<string>('model', 'gpt-4o-mini'),
		reasoningEffort: parseReasoningEffort(cfg.get<unknown>('reasoningEffort', '')),
		maxTokens: Math.floor(bounded(cfg.get<number>('maxTokens', 256), 256, 1, 2048)),
		temperature: bounded(cfg.get<number>('temperature', 0.1), 0.1, 0, 2),
		debounceMs: bounded(cfg.get<number>('debounceMs', 300), 300, 0, 5000),
		requestTimeoutMs: bounded(cfg.get<number>('requestTimeoutMs', 15000), 15000, 100, 60000),
		prefixLines: Math.floor(bounded(cfg.get<number>('prefixLines', 120), 120, 0, 1000)),
		suffixLines: Math.floor(bounded(cfg.get<number>('suffixLines', 60), 60, 0, 1000)),
		languages: cfg.get<string[]>('languages', ['*']),
		systemPrompt: cfg.get<string>('systemPrompt', '').slice(0, 2000),
		nextEditsEnabled: cfg.get<boolean>('nextEdits.enabled', false),
		nextEditsAutomatic: cfg.get<boolean>('nextEdits.automatic', false),
		nextEditsTabNavigation: cfg.get<boolean>('nextEdits.tabNavigation', false)
	};
}

export function isLanguageEnabled(config: ExtensionConfig, languageId: string): boolean {
	return config.languages.includes('*') || config.languages.includes(languageId);
}

export function documentSelector(config: ExtensionConfig): vscode.DocumentSelector {
	if (config.languages.includes('*')) {
		return { pattern: '**' };
	}
	return config.languages.map(language => ({ language }));
}

export function canSuggest(document: vscode.TextDocument, editor = vscode.window.activeTextEditor): boolean {
	const config = getConfig();
	return vscode.workspace.isTrusted && config.enabled && !document.isClosed
		&& isLanguageEnabled(config, document.languageId)
		&& ['file', 'untitled', 'vscode-remote'].includes(document.uri.scheme)
		&& !isSensitivePath(document.uri.path)
		&& (document.isUntitled || vscode.workspace.fs.isWritableFileSystem(document.uri.scheme) === true)
		&& editor?.document === document && editor.selections.length === 1 && editor.selection.isEmpty;
}
