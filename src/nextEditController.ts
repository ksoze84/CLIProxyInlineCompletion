import * as vscode from 'vscode';
import { fetchNextEdit, safeErrorMessage } from './cliProxyClient';
import { CONFIG_SECTION, canSuggest, getConfig } from './config';
import { EditHistory, PredictedEdit, buildNextEditRequest, parseNextEdit } from './nextEdit';
import { RequestCoordinator } from './requestCoordinator';

const PREVIEW_SCHEME = 'cliproxy-next-edit';

interface Candidate extends PredictedEdit {
	id: number;
	document: vscode.TextDocument;
	version: number;
	settings: string;
}

export class NextEditController implements vscode.Disposable {
	private readonly subscriptions: vscode.Disposable[] = [];
	private readonly history = new EditHistory();
	private readonly previews = new Map<string, string>();
	private readonly decoration = vscode.window.createTextEditorDecorationType({
		border: '1px solid',
		borderColor: new vscode.ThemeColor('editorInfo.foreground'),
		overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'),
		after: { contentText: '  Next edit', color: new vscode.ThemeColor('editorInfo.foreground') },
		rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
	});
	private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
	private source: vscode.TextDocument | undefined;
	private snapshot = '';
	private candidate: Candidate | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private sequence = 0;
	private rejected: string | undefined;
	private applying = false;
	private pending: { cancel(): void } | undefined;
	private navigatedId: number | undefined;
	private disposed = false;

	constructor(
		private readonly output: vscode.LogOutputChannel,
		private readonly requests: RequestCoordinator
	) {
		this.status.command = 'cliproxyInline.previewNextEdit';
		this.subscriptions.push(
			this.decoration,
			this.status,
			vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, {
				provideTextDocumentContent: uri => this.previews.get(uri.toString()) ?? ''
			}),
			vscode.window.onDidChangeActiveTextEditor(editor => this.track(editor)),
			vscode.window.onDidChangeTextEditorSelection(event => {
				if (!this.source && event.textEditor === vscode.window.activeTextEditor) {
					this.track(event.textEditor);
				}
				if (event.textEditor.document !== this.source) {
					return;
				}
				if (this.timer) {
					this.schedule();
				}
				this.pending?.cancel();
				if (!canSuggest(event.textEditor.document, event.textEditor)) {
					this.clearCandidate();
				}
				this.updatePresentation();
			}),
			vscode.workspace.onDidChangeTextDocument(event => this.changed(event)),
			vscode.workspace.onDidCloseTextDocument(document => {
				this.previews.delete(document.uri.toString());
				if (document === this.source) {
					this.reset();
				}
			}),
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(CONFIG_SECTION)) {
					this.reset();
					this.track(vscode.window.activeTextEditor);
				}
			}),
			vscode.commands.registerCommand('cliproxyInline.triggerNextEdit', () => this.trigger(false)),
			vscode.commands.registerCommand('cliproxyInline.goToNextEdit', () => this.navigate()),
			vscode.commands.registerCommand('cliproxyInline.previewNextEdit', () => this.preview()),
			vscode.commands.registerCommand('cliproxyInline.acceptNextEdit', () => this.accept()),
			vscode.commands.registerCommand('cliproxyInline.rejectNextEdit', () => this.reject())
		);
		this.track(vscode.window.activeTextEditor);
		this.updatePresentation();
	}

	private track(editor: vscode.TextEditor | undefined): void {
		if (!editor || editor.document.uri.scheme === PREVIEW_SCHEME) {
			this.updatePresentation();
			return;
		}
		if (editor.document !== this.source) {
			this.reset();
		}
		if (getConfig().nextEditsEnabled && canSuggest(editor.document, editor)
			&& editor.document.getText().length <= 2000000) {
			this.source = editor.document;
			this.snapshot = editor.document.getText();
		}
		this.updatePresentation();
	}

	private changed(event: vscode.TextDocumentChangeEvent): void {
		if (event.document !== this.source || event.contentChanges.length === 0) {
			return;
		}
		this.stopTimer();
		this.requests.cancel();
		this.clearCandidate();
		const after = event.document.getText();
		if (after.length > 2000000) {
			this.reset();
			return;
		}
		this.history.record(this.snapshot, after, event.contentChanges);
		this.snapshot = after;
		this.rejected = undefined;
		if (!this.applying && event.reason === undefined && getConfig().nextEditsAutomatic) {
			this.schedule();
		}
	}

	private schedule(): void {
		this.stopTimer();
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.trigger(true);
		}, 800);
	}

	private stopTimer(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	private async trigger(automatic: boolean): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.stopTimer();
		const config = getConfig();
		const editor = vscode.window.activeTextEditor;
		if (!editor || !config.nextEditsEnabled || !canSuggest(editor.document, editor)) {
			if (!automatic) {
				void vscode.window.showInformationMessage('Next Edits requires an eligible editor and cliproxyInline.nextEdits.enabled.');
			}
			return;
		}
		this.track(editor);
		const document = editor.document;
		const position = editor.selection.active;
		const request = buildNextEditRequest(document.languageId, vscode.workspace.asRelativePath(document.uri),
			this.snapshot, document.offsetAt(position), this.history.get());
		if (!request) {
			this.report('Next Edits: make a small edit first; no recent context available.', automatic);
			return;
		}
		const pending = this.requests.start(automatic ? 'automaticNextEdit' : 'nextEdit');
		if (!pending) {
			return;
		}
		this.clearCandidate();
		this.pending = pending;
		const version = document.version;
		const settings = JSON.stringify(config);
		const timeout = setTimeout(() => pending.cancel(), config.requestTimeoutMs);
		try {
			const raw = await fetchNextEdit(config, request, pending.signal);
			if (!pending.isCurrent() || !this.matchesRequest(document, version, settings, position)) {
				return;
			}
			const edit = parseNextEdit(raw, request.window);
			if (!edit || this.rejected === JSON.stringify([version, edit])) {
				this.report('Next Edits: no valid related edit suggested.', automatic);
				return;
			}
			this.candidate = { ...edit, id: ++this.sequence, document, version, settings };
			this.updatePresentation();
		} catch (error) {
			if (!pending.signal.aborted) {
				this.output.warn(safeErrorMessage(error));
				this.report(safeErrorMessage(error), automatic);
			}
		} finally {
			clearTimeout(timeout);
			if (this.pending === pending) {
				this.pending = undefined;
			}
			pending.finish();
		}
	}

	private report(message: string, automatic: boolean): void {
		if (!automatic) {
			vscode.window.setStatusBarMessage(message, 3000);
		}
	}

	private matchesRequest(document: vscode.TextDocument, version: number, settings: string, position: vscode.Position): boolean {
		return !this.disposed && document === this.source && document.version === version
			&& JSON.stringify(getConfig()) === settings && canSuggest(document)
			&& vscode.window.activeTextEditor!.selection.active.isEqual(position);
	}

	private isValid(candidate = this.candidate): candidate is Candidate {
		if (!candidate || this.disposed || this.candidate !== candidate || candidate.document.isClosed
			|| !vscode.workspace.isTrusted || !getConfig().nextEditsEnabled
			|| JSON.stringify(getConfig()) !== candidate.settings || candidate.document.version !== candidate.version) {
			return false;
		}
		const active = vscode.window.activeTextEditor;
		if (!active || (active.document !== candidate.document
			&& !(active.document.uri.scheme === PREVIEW_SCHEME && this.previews.has(active.document.uri.toString())))) {
			return false;
		}
		if (active.document === candidate.document && !canSuggest(candidate.document, active)) {
			return false;
		}
		return candidate.document.getText(this.range(candidate)) === candidate.oldText;
	}

	private range(candidate: Candidate): vscode.Range {
		return new vscode.Range(candidate.document.positionAt(candidate.start), candidate.document.positionAt(candidate.end));
	}

	private updatePresentation(): void {
		const candidate = this.isValid() ? this.candidate : undefined;
		for (const editor of vscode.window.visibleTextEditors) {
			editor.setDecorations(this.decoration, editor.document === candidate?.document ? [{
				range: this.range(candidate),
				hoverMessage: new vscode.MarkdownString('**Next edit**').appendCodeblock(candidate.newText || '(delete)', candidate.document.languageId)
			}] : []);
		}
		let navigated = false;
		if (candidate) {
			const editor = vscode.window.activeTextEditor;
			navigated = this.navigatedId === candidate.id && editor?.document === candidate.document
				&& editor.selection.active.isEqual(candidate.document.positionAt(candidate.start));
			if (!navigated) {
				this.navigatedId = undefined;
			}
			this.status.text = `$(edit) Next edit: ${candidate.document.positionAt(candidate.start).line + 1}`;
			this.status.tooltip = 'Preview next edit';
			this.status.show();
		} else {
			this.status.hide();
		}
		void vscode.commands.executeCommand('setContext', 'cliproxyInline.nextEditAvailable', !!candidate);
		void vscode.commands.executeCommand('setContext', 'cliproxyInline.nextEditNavigated', navigated);
	}

	private async navigate(): Promise<void> {
		const candidate = this.candidate;
		if (!this.isValid(candidate)) {
			return;
		}
		const editor = await vscode.window.showTextDocument(candidate.document, { preview: false });
		if (!this.isValid(candidate) || !canSuggest(candidate.document, editor)) {
			return;
		}
		const position = candidate.document.positionAt(candidate.start);
		editor.selection = new vscode.Selection(position, position);
		editor.revealRange(this.range(candidate), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		this.navigatedId = candidate.id;
		this.updatePresentation();
	}

	private async preview(): Promise<void> {
		const candidate = this.candidate;
		if (!this.isValid(candidate)) {
			return;
		}
		const before = candidate.document.getText();
		const after = before.slice(0, candidate.start) + candidate.newText + before.slice(candidate.end);
		const makeUri = (side: string) => vscode.Uri.from({
			scheme: PREVIEW_SCHEME,
			path: `/${candidate.id}/${side}/${candidate.document.uri.path.split('/').pop() ?? 'document'}`
		});
		const left = makeUri('before');
		const right = makeUri('after');
		this.previews.set(left.toString(), before);
		this.previews.set(right.toString(), after);
		await vscode.commands.executeCommand('vscode.diff', left, right, 'CLIProxy: Next edit', { preview: true });
		this.updatePresentation();
	}

	private async accept(): Promise<void> {
		const candidate = this.candidate;
		if (!this.isValid(candidate) || this.applying) {
			return;
		}
		const editor = await vscode.window.showTextDocument(candidate.document, { preview: false });
		if (!this.isValid(candidate) || !canSuggest(candidate.document, editor)) {
			this.clearCandidate();
			return;
		}
		this.applying = true;
		try {
			const applied = await editor.edit(builder => builder.replace(this.range(candidate), candidate.newText), {
				undoStopBefore: true,
				undoStopAfter: true
			});
			if (!applied) {
				vscode.window.setStatusBarMessage('Next Edits: the document changed; request a new suggestion.', 3000);
			}
		} finally {
			this.applying = false;
			this.clearCandidate();
		}
	}

	private reject(): void {
		this.pending?.cancel();
		if (this.candidate) {
			const { start, end, oldText, newText, version } = this.candidate;
			this.rejected = JSON.stringify([version, { start, end, oldText, newText }]);
		}
		this.stopTimer();
		this.clearCandidate();
	}

	private clearCandidate(): void {
		this.candidate = undefined;
		this.navigatedId = undefined;
		this.previews.clear();
		this.updatePresentation();
	}

	private reset(): void {
		this.stopTimer();
		this.requests.cancel();
		this.history.clear();
		this.source = undefined;
		this.snapshot = '';
		this.rejected = undefined;
		this.clearCandidate();
	}

	dispose(): void {
		this.disposed = true;
		this.reset();
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
	}
}