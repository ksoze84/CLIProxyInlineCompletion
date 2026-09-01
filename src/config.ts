import * as vscode from 'vscode';

export const CONFIG_SECTION = 'cliproxyInline';

export interface ExtensionConfig {
	enabled: boolean;
	baseUrl: string;
	apiKey: string;
	model: string;
	maxTokens: number;
	temperature: number;
	debounceMs: number;
	requestTimeoutMs: number;
	prefixLines: number;
	suffixLines: number;
	languages: string[];
	systemPrompt: string;
}

export function getConfig(): ExtensionConfig {
	const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return {
		enabled: cfg.get<boolean>('enabled', true),
		baseUrl: cfg.get<string>('baseUrl', 'http://127.0.0.1:8317').replace(/\/+$/, ''),
		apiKey: cfg.get<string>('apiKey', '').trim(),
		model: cfg.get<string>('model', 'gpt-4o-mini'),
		maxTokens: cfg.get<number>('maxTokens', 256),
		temperature: cfg.get<number>('temperature', 0.1),
		debounceMs: cfg.get<number>('debounceMs', 300),
		requestTimeoutMs: cfg.get<number>('requestTimeoutMs', 15000),
		prefixLines: cfg.get<number>('prefixLines', 120),
		suffixLines: cfg.get<number>('suffixLines', 60),
		languages: cfg.get<string[]>('languages', ['*']),
		systemPrompt: cfg.get<string>('systemPrompt', '')
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
