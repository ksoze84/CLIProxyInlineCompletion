import * as vscode from 'vscode';
import { checkBaseUrl, listModels, safeErrorMessage } from './cliProxyClient';
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
	const effort = (value: string) => value ? ` · ${value} effort` : '';
	const nextEdits = config.nextEditsEnabled
		? `\nNext Edits: ${config.nextEditsModel || config.model}${effort(config.nextEditsReasoningEffort || config.reasoningEffort)}`
		: '';
	item.tooltip = `CLIProxyApi inline completions ${config.enabled ? 'enabled' : 'disabled'} — ${config.model}${effort(config.reasoningEffort)} @ ${config.baseUrl}${nextEdits}`;
}

interface EffortPickItem extends vscode.QuickPickItem {
	effort: string;
}

function effortItems(current: string, emptyLabel: string, emptyDescription: string): EffortPickItem[] {
	const values: string[] = ['', ...REASONING_EFFORT_LEVELS];
	return values.map(effort => ({
		effort,
		label: effort ? effort[0].toUpperCase() + effort.slice(1) : emptyLabel,
		description: effort ? `reasoning_effort: ${effort}` : emptyDescription,
		picked: effort === current
	}));
}

// Write where the value is already set so a workspace value does not silently override it.
async function updateSetting(key: string, value: unknown): Promise<void> {
	const settings = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const inspected = settings.inspect(key);
	let target = vscode.ConfigurationTarget.Global;
	if (inspected?.workspaceFolderValue !== undefined) {
		target = vscode.ConfigurationTarget.WorkspaceFolder;
	} else if (inspected?.workspaceValue !== undefined) {
		target = vscode.ConfigurationTarget.Workspace;
	}
	await settings.update(key, value, target);
}

interface ModelPickItem extends vscode.QuickPickItem {
	model: string;
}

async function pickModel(output: vscode.LogOutputChannel, title: string, current: string,
	inherit?: string): Promise<string | undefined> {
	const config = getConfig();
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
	try {
		const models = await listModels(config, controller.signal);
		if (models.length === 0) {
			vscode.window.showWarningMessage('CLIProxyApi returned no models.');
			return undefined;
		}
		const items: ModelPickItem[] = models.map(model => ({ model, label: model, picked: model === current }));
		if (inherit !== undefined) {
			items.unshift({ model: '', label: 'Same as inline completions', description: inherit, picked: current === '' });
		}
		const picked = await vscode.window.showQuickPick(items, { title, placeHolder: current || inherit });
		return picked?.model;
	} catch (error) {
		const message = safeErrorMessage(error);
		output.error(message);
		vscode.window.showErrorMessage(message);
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('CLIProxy Inline Completion', { log: true });
	const requests = new RequestCoordinator();
	const nextEdits = new NextEditController(output, requests);
	const provider = new CliProxyInlineCompletionProvider(output, requests, document => nextEdits.hasCandidate(document));
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
			const model = await pickModel(output, 'Inline completion model', getConfig().model);
			if (model) {
				await updateSetting('model', model);
				updateStatusBar(statusBarItem);
			}
		}),
		vscode.commands.registerCommand('cliproxyInline.selectReasoningEffort', async () => {
			const config = getConfig();
			const picked = await vscode.window.showQuickPick(
				effortItems(config.reasoningEffort, 'Server default', 'omit reasoning_effort'), {
					title: 'Inline completion reasoning effort',
					placeHolder: config.reasoningEffort || 'Server default'
				});
			if (!picked) {
				return;
			}
			await updateSetting('reasoningEffort', picked.effort);
			updateStatusBar(statusBarItem);
			vscode.window.setStatusBarMessage(
				`CLIProxy reasoning effort: ${picked.effort || 'server default'}`,
				2000
			);
		}),
		vscode.commands.registerCommand('cliproxyInline.selectNextEditModel', async () => {
			const config = getConfig();
			const model = await pickModel(output, 'Next Edits model', config.nextEditsModel, config.model);
			if (model !== undefined) {
				await updateSetting('nextEdits.model', model);
				updateStatusBar(statusBarItem);
			}
		}),
		vscode.commands.registerCommand('cliproxyInline.selectNextEditReasoningEffort', async () => {
			const config = getConfig();
			const inherited = config.reasoningEffort || 'server default';
			const picked = await vscode.window.showQuickPick(
				effortItems(config.nextEditsReasoningEffort, 'Same as inline completions', inherited), {
					title: 'Next Edits reasoning effort',
					placeHolder: config.nextEditsReasoningEffort || inherited
				});
			if (!picked) {
				return;
			}
			await updateSetting('nextEdits.reasoningEffort', picked.effort);
			updateStatusBar(statusBarItem);
			vscode.window.setStatusBarMessage(`Next Edits reasoning effort: ${picked.effort || inherited}`, 2000);
		}),
		vscode.commands.registerCommand('cliproxyInline.setBaseUrl', async () => {
			const value = await vscode.window.showInputBox({
				title: 'CLIProxyApi URL',
				prompt: 'Server root used for completions, Next Edits and the model list',
				value: getConfig().baseUrl,
				placeHolder: 'http://127.0.0.1:8317',
				ignoreFocusOut: true,
				validateInput: input => {
					const { error, warning } = checkBaseUrl(input);
					return error ?? (warning ? { message: warning, severity: vscode.InputBoxValidationSeverity.Warning } : undefined);
				}
			});
			if (value === undefined || checkBaseUrl(value).error) {
				return;
			}
			await updateSetting('baseUrl', value.trim());
			updateStatusBar(statusBarItem);
			vscode.window.setStatusBarMessage(`CLIProxyApi URL: ${getConfig().baseUrl}`, 2000);
		})
	);
}

export function deactivate(): void {
	providerRegistration?.dispose();
	providerRegistration = undefined;
}
