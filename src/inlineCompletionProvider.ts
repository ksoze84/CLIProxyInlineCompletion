import * as vscode from 'vscode';
import { CompletionRequest, fetchCompletion } from './cliProxyClient';
import { sanitizeCompletion } from './completionText';
import { ExtensionConfig, getConfig, isLanguageEnabled } from './config';

interface CacheEntry {
	key: string;
	completion: string;
}

function delay(ms: number, token: vscode.CancellationToken): Promise<boolean> {
	return new Promise(resolve => {
		const timer = setTimeout(() => {
			subscription.dispose();
			resolve(true);
		}, ms);
		const subscription = token.onCancellationRequested(() => {
			clearTimeout(timer);
			resolve(false);
		});
	});
}

function buildRequest(
	config: ExtensionConfig,
	document: vscode.TextDocument,
	position: vscode.Position
): CompletionRequest {
	const startLine = Math.max(0, position.line - config.prefixLines);
	const endLine = Math.min(document.lineCount - 1, position.line + config.suffixLines);

	const prefix = document.getText(new vscode.Range(new vscode.Position(startLine, 0), position));
	const suffix = document.getText(
		new vscode.Range(position, document.lineAt(endLine).range.end)
	);

	return {
		languageId: document.languageId,
		fileName: vscode.workspace.asRelativePath(document.uri),
		prefix,
		suffix
	};
}

export class CliProxyInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
	private cache: CacheEntry | undefined;

	constructor(private readonly output: vscode.LogOutputChannel) {}

	async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken
	): Promise<vscode.InlineCompletionItem[] | undefined> {
		const config = getConfig();
		if (!config.enabled || !isLanguageEnabled(config, document.languageId)) {
			return undefined;
		}

		const request = buildRequest(config, document, position);
		const cacheKey = `${document.uri.toString()}::${request.prefix}::${request.suffix}`;
		if (this.cache?.key === cacheKey) {
			return [new vscode.InlineCompletionItem(this.cache.completion)];
		}

		const automatic = context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic;
		if (automatic && config.debounceMs > 0 && !(await delay(config.debounceMs, token))) {
			return undefined;
		}
		if (token.isCancellationRequested) {
			return undefined;
		}

		const controller = new AbortController();
		const cancellation = token.onCancellationRequested(() => controller.abort());
		const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

		try {
			const raw = await fetchCompletion(config, request, controller.signal);
			const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
			const completion = sanitizeCompletion(raw, linePrefix, request.suffix);
			if (completion.length === 0 || token.isCancellationRequested) {
				return undefined;
			}

			this.cache = { key: cacheKey, completion };
			return [new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))];
		} catch (error) {
			if (!token.isCancellationRequested) {
				this.output.error(error instanceof Error ? error.message : String(error));
			}
			return undefined;
		} finally {
			clearTimeout(timeout);
			cancellation.dispose();
		}
	}
}
