import * as vscode from 'vscode';
import { listModels, safeErrorMessage } from './cliProxyClient';
import { CONFIG_SECTION, REASONING_EFFORT_LEVELS, documentSelector, getConfig } from './config';
import { CliProxyInlineCompletionProvider } from './inlineCompletionProvider';
import { NextEditController } from './nextEditController';
import { RequestCoordinator } from './requestCoordinator';

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
	const effort = config.reasoningEffort ? ` · ${config.reasoningEffort} effort` : '';
	item.tooltip = `CLIProxyApi inline completions ${config.enabled ? 'enabled' : 'disabled'} — ${config.model}${effort} @ ${config.baseUrl}`;
}

interface EffortPickItem extends vscode.QuickPickItem {
	effort: string;
}

function effortItems(current: string): EffortPickItem[] {
	const values: string[] = ['', ...REASONING_EFFORT_LEVELS];
	return values.map(effort => ({
		effort,
		label: effort ? effort[0].toUpperCase() + effort.slice(1) : 'Server default',
		description: effort ? `reasoning_effort: ${effort}` : 'omit reasoning_effort',
		picked: effort === current
	}));
}

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('CLIProxy Inline Completion', { log: true });
	const requests = new RequestCoordinator();
	const provider = new CliProxyInlineCompletionProvider(output, requests);
	const nextEdits = new NextEditController(output, requests);
	const statusBarItem = createStatusBarItem();

	registerProvider(provider);
	updateStatusBar(statusBarItem);

	context.subscriptions.push(
		requests,
		nextEdits,
		output,
		statusBarItem,
		new vscode.Disposable(() => providerRegistration?.dispose()),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (!event.affectsConfiguration(CONFIG_SECTION)) {
				return;
			}
			provider.reset();
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
				const message = safeErrorMessage(error);
				output.error(message);
				vscode.window.showErrorMessage(message);
			} finally {
				clearTimeout(timeout);
			}
		}),
		vscode.commands.registerCommand('cliproxyInline.selectReasoningEffort', async () => {
			const config = getConfig();
			const picked = await vscode.window.showQuickPick(effortItems(config.reasoningEffort), {
				title: 'Reasoning effort',
				placeHolder: config.reasoningEffort || 'Server default'
			});
			if (!picked) {
				return;
			}
			await vscode.workspace
				.getConfiguration(CONFIG_SECTION)
				.update('reasoningEffort', picked.effort, vscode.ConfigurationTarget.Global);
			updateStatusBar(statusBarItem);
			vscode.window.setStatusBarMessage(
				`CLIProxy reasoning effort: ${picked.effort || 'server default'}`,
				2000
			);
		})
	);
}

export function deactivate(): void {
	providerRegistration?.dispose();
	providerRegistration = undefined;
}
