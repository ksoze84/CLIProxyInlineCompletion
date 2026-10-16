const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { startServer, reply } = require('./helpers.cjs');

function emitter() {
  const listeners = new Set();
  return {
    event: listener => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
    fire: value => { for (const listener of listeners) listener(value); }
  };
}

class Position {
  constructor(line, character) { this.line = line; this.character = character; }
  isEqual(other) { return this.line === other.line && this.character === other.character; }
}

class Range {
  constructor(start, end) { this.start = start; this.end = end; }
  get isSingleLine() { return this.start.line === this.end.line; }
  get isEmpty() { return this.start.isEqual(this.end); }
  contains(position) {
    return this.isSingleLine && position.line === this.start.line
      && position.character >= this.start.character && position.character <= this.end.character;
  }
}

class Selection extends Range {
  constructor(start, end) { super(start, end); this.active = end; }
}

class Uri {
  constructor(scheme, path) { this.scheme = scheme; this.path = path; }
  toString() { return `${this.scheme}:${this.path}`; }
  static from(value) { return new Uri(value.scheme, value.path); }
}

function environment() {
  const changed = emitter();
  const active = emitter();
  const selectionChanged = emitter();
  const closed = emitter();
  const configured = emitter();
  const commands = new Map();
  const contexts = new Map();
  const contextChanged = emitter();
  const providers = new Map();
  const settings = new Map([['enabled', true], ['nextEdits.enabled', true], ['nextEdits.automatic', false], ['debounceMs', 0]]);
  const errors = [];
  const disposable = () => ({ dispose() {} });
  const api = {
    Position, Range, Selection, Uri,
    InlineCompletionItem: class { constructor(insertText, range) { this.insertText = insertText; this.range = range; } },
    InlineCompletionTriggerKind: { Automatic: 1, Invoke: 0 },
    EndOfLine: { LF: 1, CRLF: 2 },
    StatusBarAlignment: { Right: 2 },
    DecorationRangeBehavior: { ClosedClosed: 1 },
    TextEditorRevealType: { InCenterIfOutsideViewport: 1 },
    ThemeColor: class { constructor(id) { this.id = id; } },
    MarkdownString: class { appendCodeblock() { return this; } },
    workspace: {
      isTrusted: true,
      fs: { isWritableFileSystem: () => true },
      asRelativePath: uri => uri.path,
      getConfiguration: () => ({ get: (key, fallback) => settings.has(key) ? settings.get(key) : fallback }),
      onDidChangeTextDocument: changed.event,
      onDidCloseTextDocument: closed.event,
      onDidChangeConfiguration: configured.event,
      registerTextDocumentContentProvider: (scheme, provider) => {
        providers.set(scheme, provider);
        return { dispose: () => providers.delete(scheme) };
      }
    },
    window: {
      activeTextEditor: undefined,
      visibleTextEditors: [],
      onDidChangeActiveTextEditor: active.event,
      onDidChangeTextEditorSelection: selectionChanged.event,
      createTextEditorDecorationType: disposable,
      createStatusBarItem: () => ({ ...disposable(), show() {}, hide() {} }),
      setStatusBarMessage: disposable,
      showInformationMessage: async () => undefined,
      showTextDocument: async document => show(document)
    },
    commands: {
      registerCommand: (id, callback) => { commands.set(id, callback); return { dispose: () => commands.delete(id) }; },
      executeCommand: async (id, ...args) => {
        if (id === 'setContext') {
          contexts.set(args[0], args[1]);
          contextChanged.fire(args);
        }
        else if (id === 'vscode.diff') {
          api.diff = args;
          await show(makeDocument(providers.get(args[1].scheme).provideTextDocumentContent(args[1]), args[1]));
        } else return commands.get(id)?.(...args);
      }
    }
  };
  function makeDocument(text, uri = new Uri('untitled', '/test.ts')) {
    return {
      uri, text, version: 1, languageId: 'typescript', eol: 1, isClosed: false,
      get isUntitled() { return uri.scheme === 'untitled'; },
      get lineCount() { return this.text.split('\n').length; },
      offsetAt(position) {
        const lines = this.text.split('\n');
        return lines.slice(0, position.line).reduce((total, line) => total + line.length + 1, 0) + position.character;
      },
      positionAt(offset) {
        const lines = this.text.slice(0, offset).split('\n');
        return new Position(lines.length - 1, lines.at(-1).length);
      },
      getText(range) { return range ? this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end)) : this.text; },
      lineAt(line) {
        const value = this.text.split('\n')[line];
        return { text: value, range: new Range(new Position(line, 0), new Position(line, value.length)) };
      }
    };
  }
  const editors = new Map();
  async function show(document) {
    let editor = editors.get(document);
    if (!editor) {
      let selection = new Selection(new Position(0, 0), new Position(0, 0));
      editor = {
        document, decorations: [], selections: [selection],
        get selection() { return selection; },
        set selection(value) {
          selection = value;
          this.selections = [value];
          selectionChanged.fire({ textEditor: this });
        },
        revealRange(range) { this.revealed = range; },
        setDecorations(_type, values) { this.decorations = values; },
        edit: async (callback, options) => {
          editor.undoOptions = options;
          callback({ replace: (range, newText) => edit(document, document.offsetAt(range.start), document.offsetAt(range.end) - document.offsetAt(range.start), newText) });
          return true;
        }
      };
      editors.set(document, editor);
    }
    api.window.activeTextEditor = editor;
    api.window.visibleTextEditors = [...editors.values()];
    active.fire(editor);
    return editor;
  }
  function edit(document, offset, length, text, reason) {
    document.text = document.text.slice(0, offset) + text + document.text.slice(offset + length);
    document.version += 1;
    changed.fire({ document, reason, contentChanges: [{ rangeOffset: offset, rangeLength: length, text }] });
  }
  const available = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { subscription.dispose(); reject(new Error('Candidate timed out')); }, 5000);
    const subscription = contextChanged.event(([key, value]) => {
      if (key === 'cliproxyInline.nextEditAvailable' && value) {
        clearTimeout(timer);
        subscription.dispose();
        resolve();
      }
    });
  });
  return { api, settings, contexts, providers, makeDocument, show, edit, configured, available,
    output: { error: message => errors.push(message), warn: message => errors.push(message) }, errors };
}

test('editor adapter: completion ranges, config invalidation, cancellation and NES review lifecycle', async () => {
  const env = environment();
  const load = Module._load;
  Module._load = function(id, ...args) { return id === 'vscode' ? env.api : load.call(this, id, ...args); };
  let CliProxyInlineCompletionProvider, NextEditController;
  try {
    ({ CliProxyInlineCompletionProvider } = require('../out/inlineCompletionProvider'));
    ({ NextEditController } = require('../out/nextEditController'));
  } finally { Module._load = load; }
  const { RequestCoordinator } = require('../out/requestCoordinator');
  const requests = new RequestCoordinator();
  const provider = new CliProxyInlineCompletionProvider(env.output, requests);
  let content = 'suffix';
  let held;
  let started;
  const server = await startServer(async (_entry, response) => {
    const result = content;
    started?.();
    if (held) await held;
    reply(response, result);
  });
  env.settings.set('baseUrl', server.baseUrl);
  const document = env.makeDocument('const count = value;');
  let editor = await env.show(document);
  const cancellation = emitter();
  const token = { isCancellationRequested: false, onCancellationRequested: cancellation.event };
  const invoke = { triggerKind: 0, selectedCompletionInfo: undefined };
  const position = new Position(0, 8);
  editor.selection = new Selection(position, position);
  const controller = new NextEditController(env.output, requests);
  const command = name => env.api.commands.executeCommand(`cliproxyInline.${name}`);
  try {
    const first = await provider.provideInlineCompletionItems(document, position, invoke, token);
    const cached = await provider.provideInlineCompletionItems(document, position, invoke, token);
    assert.equal(first[0].range.isEmpty, true);
    assert.deepEqual(cached[0], first[0]);
    assert.equal(server.requests.length, 1);
    env.settings.set('model', 'new-model');
    await provider.provideInlineCompletionItems(document, position, invoke, token);
    assert.equal(server.requests.length, 2);
    env.settings.set('reasoningEffort', 'low');
    await provider.provideInlineCompletionItems(document, position, invoke, token);
    assert.equal(server.requests[2].body.reasoning_effort, 'low');
    env.settings.set('reasoningEffort', 'bogus');
    await provider.provideInlineCompletionItems(document, position, invoke, token);
    assert.equal('reasoning_effort' in server.requests[3].body, false);
    env.settings.set('reasoningEffort', '');
    const selectedRange = new Range(new Position(0, 14), new Position(0, 19));
    const selectedPosition = new Position(0, 19);
    editor.selection = new Selection(selectedPosition, selectedPosition);
    content = ' + 1';
    const selected = await provider.provideInlineCompletionItems(document, selectedPosition,
      { ...invoke, selectedCompletionInfo: { range: selectedRange, text: 'value' } }, token);
    assert.equal(selected[0].insertText, 'value + 1');
    assert.deepEqual(selected[0].range, selectedRange);
    let release;
    held = new Promise(resolve => { release = resolve; });
    const startedPromise = new Promise(resolve => { started = resolve; });
    const stale = provider.provideInlineCompletionItems(document, selectedPosition, invoke, token);
    await startedPromise;
    env.edit(document, 0, 0, '// change\n');
    release();
    held = undefined;
    started = undefined;
    assert.equal(await stale, undefined);
    token.isCancellationRequested = true;
    assert.equal(await provider.provideInlineCompletionItems(document, position, invoke, token), undefined);
    token.isCancellationRequested = false;

    const source = env.makeDocument('function name() {}\nconst value = name();\n');
    editor = await env.show(source);
    env.edit(source, 9, 4, 'displayName');
    const before = source.text;
    content = JSON.stringify({ edit: { oldText: 'const value = name();', newText: 'const value = displayName();' } });
    await command('triggerNextEdit');
    assert.equal(source.text, before);
    assert.equal(env.contexts.get('cliproxyInline.nextEditAvailable'), true);
    assert.equal(env.contexts.get('cliproxyInline.nextEditNavigated'), false);
    await command('goToNextEdit');
    assert.equal(editor.selection.active.line, 1);
    assert.equal(env.contexts.get('cliproxyInline.nextEditNavigated'), true);
    await command('previewNextEdit');
    const [left, right] = env.api.diff;
    const preview = env.providers.get(left.scheme);
    assert.equal(preview.provideTextDocumentContent(left), before);
    assert.equal(preview.provideTextDocumentContent(right), before.replace('const value = name();', 'const value = displayName();'));
    assert.equal(source.text, before);
    await command('acceptNextEdit');
    assert.ok(source.text.includes('const value = displayName();'));
    assert.deepEqual(editor.undoOptions, { undoStopBefore: true, undoStopAfter: true });
    assert.equal(env.contexts.get('cliproxyInline.nextEditAvailable'), false);
    env.edit(source, 0, source.text.length, before);
    await command('triggerNextEdit');
    env.edit(source, 0, 0, '// user\n');
    const userVersion = source.text;
    await command('acceptNextEdit');
    assert.equal(source.text, userVersion);
    await command('triggerNextEdit');
    await command('rejectNextEdit');
    await command('triggerNextEdit');
    assert.equal(env.contexts.get('cliproxyInline.nextEditAvailable'), false);
    await command('acceptNextEdit');
    assert.equal(source.text, userVersion);
    env.settings.set('nextEdits.automatic', true);
    env.configured.fire({ affectsConfiguration: () => true });
    const automatic = env.available();
    const size = server.requests.length;
    env.edit(source, 0, 0, '// first\n');
    editor.selection = new Selection(new Position(0, 0), new Position(0, 0));
    env.edit(source, 0, 0, '// second\n');
    editor.selection = new Selection(new Position(0, 0), new Position(0, 0));
    assert.equal(server.requests.length, size);
    await automatic;
    assert.equal(server.requests.length, size + 1);
    await command('acceptNextEdit');
    const acceptedSize = server.requests.length;
    await new Promise(resolve => setTimeout(resolve, 900));
    assert.equal(server.requests.length, acceptedSize);
    env.settings.set('nextEdits.automatic', false);
    env.configured.fire({ affectsConfiguration: () => true });
    env.edit(source, 0, source.text.length, before);
    held = new Promise(resolve => { release = resolve; });
    const nextStarted = new Promise(resolve => { started = resolve; });
    const staleEdit = command('triggerNextEdit');
    await nextStarted;
    env.edit(source, 0, 0, '// newer\n');
    release();
    held = undefined;
    started = undefined;
    await staleEdit;
    assert.equal(env.contexts.get('cliproxyInline.nextEditAvailable'), false);
    assert.ok(source.text.includes('const value = name();'));
    editor.selection = new Selection(new Position(0, 0), new Position(0, 4));
    env.configured.fire({ affectsConfiguration: () => true });
    editor.selection = new Selection(new Position(0, 0), new Position(0, 0));
    env.edit(source, 0, 0, '// resumed\n');
    const resumedSize = server.requests.length;
    await command('triggerNextEdit');
    assert.equal(server.requests.length, resumedSize + 1, 'NES records edits after the selection becomes eligible');
    assert.equal(env.contexts.get('cliproxyInline.nextEditAvailable'), true);
    env.settings.set('nextEdits.enabled', false);
    env.configured.fire({ affectsConfiguration: () => true });
    assert.equal(env.contexts.get('cliproxyInline.nextEditAvailable'), false);
    env.api.workspace.isTrusted = false;
    assert.equal(await provider.provideInlineCompletionItems(source, position, invoke, token), undefined);
    assert.deepEqual(env.errors, []);
  } finally {
    controller.dispose();
    provider.reset();
    requests.dispose();
    await server.close();
  }
});