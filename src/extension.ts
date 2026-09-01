import * as vscode from 'vscode';
import { listModels } from './cliProxyClient';
import { CONFIG_SECTION, documentSelector, getConfig } from './config';
import { CliProxyInlineCompletionProvider } from './inlineCompletionProvider';

let providerRegistration: vscode.Disposable | undefined;

function registerProvider(provider: CliProxyInlineCompletionProvider): void {
	providerRegistration?.dispose();
	providerRegistration = vscode.languages.registerInlineCompletionItemProvider(
		documentSelector(getConfig()),
		provider
	);
}

function createStatusBarItem(): vscode.StatusBarItem {
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	item.command = 'cliproxyInline.toggle';
	item.show();
	return item;
}

function updateStatusBar(item: vscode.StatusBarItem): void {
	const config = getConfig();
	item.text = config.enabled ? '$(sparkle) CLIProxy' : '$(circle-slash) CLIProxy';
	item.tooltip = `CLIProxyApi inline completions ${config.enabled ? 'enabled' : 'disabled'} — ${config.model} @ ${config.baseUrl}`;
}

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('CLIProxy Inline Completion', { log: true });
	const provider = new CliProxyInlineCompletionProvider(output);
	const statusBarItem = createStatusBarItem();

	registerProvider(provider);
	updateStatusBar(statusBarItem);

	context.subscriptions.push(
		output,
		statusBarItem,
		new vscode.Disposable(() => providerRegistration?.dispose()),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (!event.affectsConfiguration(CONFIG_SECTION)) {
				return;
			}
			if (event.affectsConfiguration(`${CONFIG_SECTION}.languages`)) {
				registerProvider(provider);
			}
			updateStatusBar(statusBarItem);
		}),
		vscode.commands.registerCommand('cliproxyInline.toggle', async () => {
			const settings = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const enabled = !settings.get<boolean>('enabled', true);
			await settings.update('enabled', enabled, vscode.ConfigurationTarget.Global);
			updateStatusBar(statusBarItem);
			vscode.window.setStatusBarMessage(
				`CLIProxy inline completions ${enabled ? 'enabled' : 'disabled'}`,
				2000
			);
		}),
		vscode.commands.registerCommand('cliproxyInline.triggerCompletion', () =>
			vscode.commands.executeCommand('editor.action.inlineSuggest.trigger')
		),
		vscode.commands.registerCommand('cliproxyInline.selectModel', async () => {
			const config = getConfig();
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
			try {
				const models = await listModels(config, controller.signal);
				if (models.length === 0) {
					vscode.window.showWarningMessage('CLIProxyApi returned no models.');
					return;
				}
				const picked = await vscode.window.showQuickPick(models, {
					title: 'CLIProxyApi model',
					placeHolder: config.model
				});
				if (picked) {
					await vscode.workspace
						.getConfiguration(CONFIG_SECTION)
						.update('model', picked, vscode.ConfigurationTarget.Global);
					updateStatusBar(statusBarItem);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				output.error(message);
				vscode.window.showErrorMessage(`Could not reach CLIProxyApi at ${config.baseUrl}: ${message}`);
			} finally {
				clearTimeout(timeout);
			}
		})
	);
}

export function deactivate(): void {
	providerRegistration?.dispose();
	providerRegistration = undefined;
}
