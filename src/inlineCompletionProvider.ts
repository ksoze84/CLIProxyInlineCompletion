import * as vscode from 'vscode';
import { CompletionRequest, fetchCompletion, safeErrorMessage } from './cliProxyClient';
import { sanitizeCompletion } from './completionText';
import { ExtensionConfig, canSuggest, getConfig } from './config';
import { RequestCoordinator, waitForIdle } from './requestCoordinator';
import { CONTEXT_LIMIT, contextWindow } from './textContext';

interface CacheEntry {
	key: string;
	completion: string;
}

function buildRequest(
	config: ExtensionConfig,
	document: vscode.TextDocument,
	position: vscode.Position,
	selected: vscode.SelectedCompletionInfo | undefined
): CompletionRequest | undefined {
	const startLine = Math.max(0, position.line - config.prefixLines);
	const endLine = Math.min(document.lineCount - 1, position.line + config.suffixLines);
	const prefix = document.getText(new vscode.Range(new vscode.Position(startLine, 0), selected?.range.start ?? position))
		+ (selected?.text ?? '');
	const suffix = document.getText(new vscode.Range(selected?.range.end ?? position, document.lineAt(endLine).range.end));
	let budget = CONTEXT_LIMIT - 3000;
	while (budget > 0) {
		const window = contextWindow(prefix + suffix, prefix.length, budget);
		if (!window) {
			return undefined;
		}
		const split = prefix.length - window.start;
		const request = {
			languageId: document.languageId,
			fileName: vscode.workspace.asRelativePath(document.uri),
			prefix: window.text.slice(0, split),
			suffix: window.text.slice(split)
		};
		if (JSON.stringify(request).length <= CONTEXT_LIMIT - 3000) {
			return request;
		}
		budget = Math.floor(budget / 2);
	}
	return undefined;
}

export class CliProxyInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
	private cache: CacheEntry | undefined;

	constructor(
		private readonly output: vscode.LogOutputChannel,
		private readonly requests = new RequestCoordinator(),
		private readonly suppressed: (document: vscode.TextDocument) => boolean = () => false
	) {}

	reset(): void {
		this.cache = undefined;
		this.requests.cancel('completion');
	}

	async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken
	): Promise<vscode.InlineCompletionItem[] | undefined> {
		const config = getConfig();
		if (!canSuggest(document) || token.isCancellationRequested || this.suppressed(document)) {
			return undefined;
		}
		const selected = context.selectedCompletionInfo;
		if (!this.compatibleSelection(selected, position)) {
			return undefined;
		}
		const request = buildRequest(config, document, position, selected);
		if (!request) {
			return undefined;
		}
		const pending = this.requests.start('completion');
		const version = document.version;
		const settings = JSON.stringify(config);
		const cursor = vscode.window.activeTextEditor!.selection.active;
		const valid = () => pending.isCurrent() && this.matchesRequest(document, version, settings, cursor, token);
		const range = selected ? selected.range : new vscode.Range(position, position);
		const cacheKey = JSON.stringify([document.uri.toString(), version, position, settings, request, selected]);
		const cancellation = token.onCancellationRequested(() => pending.cancel());
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			if (this.cache?.key === cacheKey && valid()) {
				return [new vscode.InlineCompletionItem(this.cache.completion, range)];
			}
			if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic
				&& !(await waitForIdle(config.debounceMs, pending.signal))) {
				return undefined;
			}
			if (!valid()) {
				return undefined;
			}
			timeout = setTimeout(() => pending.cancel(), config.requestTimeoutMs);
			const raw = await fetchCompletion(config, request, pending.signal);
			if (!valid() || raw.length > 16000) {
				return undefined;
			}
			const completion = this.cleanResponse(raw, request, document);
			if (!completion) {
				return undefined;
			}
			const insertText = this.withSelectedText(selected, completion);
			this.cache = { key: cacheKey, completion: insertText };
			return [new vscode.InlineCompletionItem(insertText, range)];
		} catch (error) {
			if (!pending.signal.aborted) {
				this.output.error(safeErrorMessage(error));
			}
			return undefined;
		} finally {
			clearTimeout(timeout);
			cancellation.dispose();
			pending.finish();
		}
	}

	private withSelectedText(selected: vscode.SelectedCompletionInfo | undefined, completion: string): string {
		return (selected?.text ?? '') + completion;
	}

	private compatibleSelection(selected: vscode.SelectedCompletionInfo | undefined, position: vscode.Position): boolean {
		return !selected || (selected.range.isSingleLine && selected.range.contains(position));
	}

	private matchesRequest(document: vscode.TextDocument, version: number, settings: string,
		cursor: vscode.Position, token: vscode.CancellationToken): boolean {
		return !token.isCancellationRequested && document.version === version && canSuggest(document)
			&& !this.suppressed(document)
			&& vscode.window.activeTextEditor!.selection.active.isEqual(cursor)
			&& JSON.stringify(getConfig()) === settings;
	}

	private cleanResponse(raw: string, request: CompletionRequest, document: vscode.TextDocument): string {
		const linePrefix = request.prefix.slice(request.prefix.lastIndexOf('\n') + 1);
		return sanitizeCompletion(raw, linePrefix, request.suffix, document.languageId,
			document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
	}
}
