const assert = require('node:assert/strict');
const vscode = require('vscode');
const { startServer, reply } = require('./helpers.cjs');
const { CliProxyInlineCompletionProvider } = require('../out/inlineCompletionProvider');

exports.run = async () => {
  let nextReply = 'answer;';
  let waiting;
  const server = await startServer(async (_entry, response) => {
    const content = nextReply;
    if (waiting) await waiting;
    reply(response, content);
  });
  const config = vscode.workspace.getConfiguration('cliproxyInline');
  const old = new Map();
  const set = async (key, value) => {
    if (!old.has(key)) old.set(key, config.inspect(key)?.globalValue);
    await config.update(key, value, vscode.ConfigurationTarget.Global);
  };
  const output = vscode.window.createOutputChannel('CLIProxy integration', { log: true });
  const provider = new CliProxyInlineCompletionProvider(output);
  let count = 0;
  const check = async (name, action) => {
    await action();
    count += 1;
    console.log(`PASS ${name}`);
  };
  const command = name => vscode.commands.executeCommand(`cliproxyInline.${name}`);
  const move = async (editor, position) => {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { subscription.dispose(); reject(new Error('Cursor event timed out')); }, 5000);
      const subscription = vscode.window.onDidChangeTextEditorSelection(event => {
        if (event.textEditor.document === editor.document && event.selections[0].active.isEqual(position)) {
          clearTimeout(timeout);
          subscription.dispose();
          resolve();
        }
      });
      editor.selection = new vscode.Selection(position, position);
    });
  };
  const context = { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined };
  const suggest = (document, position, extra = {}) => provider.provideInlineCompletionItems(document, position, { ...context, ...extra }, new vscode.CancellationTokenSource().token);
  const document = await vscode.workspace.openTextDocument({ content: 'const count = value;', language: 'typescript' });
  let editor = await vscode.window.showTextDocument(document);
  try {
    await set('baseUrl', server.baseUrl);
    await set('apiKey', '');
    await set('enabled', true);
    await set('debounceMs', 5000);
    await set('nextEdits.enabled', true);
    await set('nextEdits.automatic', false);
    await vscode.extensions.getExtension('ksoze84.cliproxy-inline-completion').activate();
    await check('completion cache preserves insertion range inside a word', async () => {
      nextReply = 'suffix';
      const position = new vscode.Position(0, 8);
      await move(editor, position);
      const first = await suggest(document, position);
      const second = await suggest(document, position);
      assert.ok(first?.length && second?.length);
      assert.ok(first[0].range.isEmpty);
      assert.ok(first[0].range.isEqual(second[0].range));
      assert.equal(second[0].insertText, first[0].insertText);
    });
    await check('IntelliSense completion extends the selected item at its range', async () => {
      nextReply = ' + 1';
      const position = new vscode.Position(0, 19);
      await move(editor, position);
      const range = new vscode.Range(0, 14, 0, 19);
      const items = await suggest(document, position, { selectedCompletionInfo: { range, text: 'value' } });
      assert.ok(items?.length, JSON.stringify({ selection: editor.selection, version: document.version,
        active: vscode.window.activeTextEditor?.document.uri.toString(), source: document.uri.toString(),
        request: server.requests.at(-1)?.body, writable: vscode.workspace.fs.isWritableFileSystem('untitled') }));
      assert.equal(items[0].insertText, 'value + 1');
      assert.ok(items[0].range.isEqual(range));
    });
    await check('completion arriving after a document edit is discarded', async () => {
      let release;
      waiting = new Promise(resolve => { release = resolve; });
      nextReply = 'new';
      const position = new vscode.Position(0, 0);
      await move(editor, position);
      const result = suggest(document, position);
      await editor.edit(builder => builder.insert(new vscode.Position(0, 0), '// changed\n'));
      release();
      waiting = undefined;
      assert.equal(await result, undefined);
    });

    const nesDocument = await vscode.workspace.openTextDocument({
      language: 'typescript',
      content: 'function name() { return 1; }\n\nconst result = name();\n'
    });
    editor = await vscode.window.showTextDocument(nesDocument);
    await editor.edit(builder => builder.replace(new vscode.Range(0, 9, 0, 13), 'displayName'));
    await move(editor, new vscode.Position(0, 20));
    const before = nesDocument.getText();
    nextReply = JSON.stringify({ edit: { oldText: 'const result = name();', newText: 'const result = displayName();' } });
    await check('manual NES predicts another line without editing the buffer', async () => {
      await command('triggerNextEdit');
      assert.equal(nesDocument.getText(), before);
      await command('goToNextEdit');
      assert.equal(editor.selection.active.line, 2);
    });
    await check('preview contains exact immutable snapshots and acceptance edits only the source', async () => {
      await command('previewNextEdit');
      const previews = vscode.workspace.textDocuments.filter(item => item.uri.scheme === 'cliproxy-next-edit');
      assert.equal(previews.length, 2);
      assert.ok(previews.some(item => item.getText() === before));
      assert.ok(previews.some(item => item.getText() === before.replace('const result = name();', 'const result = displayName();')));
      assert.equal(nesDocument.getText(), before);
      await command('acceptNextEdit');
      editor = vscode.window.activeTextEditor;
      assert.ok(nesDocument.getText().includes('const result = displayName();'));
      assert.equal(nesDocument.isDirty, true);
    });
    await check('accepted NES is one undo/redo operation preserving earlier user changes', async () => {
      await vscode.commands.executeCommand('undo');
      assert.equal(nesDocument.getText(), before);
      await vscode.commands.executeCommand('redo');
      assert.ok(nesDocument.getText().includes('const result = displayName();'));
    });
    await check('a changed source invalidates the candidate before acceptance', async () => {
      await vscode.commands.executeCommand('undo');
      await command('triggerNextEdit');
      await editor.edit(builder => builder.insert(new vscode.Position(0, 0), '// user\n'));
      const current = nesDocument.getText();
      await command('acceptNextEdit');
      assert.equal(nesDocument.getText(), current);
    });
    await check('rejection never applies an edit or repeats it on the same version', async () => {
      await command('triggerNextEdit');
      const current = nesDocument.getText();
      await command('rejectNextEdit');
      await command('triggerNextEdit');
      await command('acceptNextEdit');
      assert.equal(nesDocument.getText(), current);
    });
    await check('multiple cursors are excluded from requests', async () => {
      editor.selections = [new vscode.Selection(0, 0, 0, 0), new vscode.Selection(1, 0, 1, 0)];
      const size = server.requests.length;
      const items = await suggest(nesDocument, new vscode.Position(0, 0));
      assert.equal(items, undefined);
      assert.equal(server.requests.length, size);
    });
    console.log(`INTEGRATION: ${count} checks passed on VS Code ${vscode.version}`);
  } finally {
    waiting = undefined;
    for (const [key, value] of old) await config.update(key, value, vscode.ConfigurationTarget.Global);
    output.dispose();
    await server.close();
  }
};