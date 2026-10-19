const Module = require('node:module');
const path = require('node:path');

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
    executed: [],
    commands: {
      registerCommand: (id, callback) => { commands.set(id, callback); return { dispose: () => commands.delete(id) }; },
      executeCommand: async (id, ...args) => {
        api.executed.push(id);
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
  const available = (timeoutMs = 5000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { subscription.dispose(); reject(new Error('Candidate timed out')); }, timeoutMs);
    const subscription = contextChanged.event(([key, value]) => {
      if (key === 'cliproxyInline.nextEditAvailable' && value) {
        clearTimeout(timer);
        subscription.dispose();
        resolve();
      }
    });
  });
  const logs = [];
  return { api, settings, contexts, providers, makeDocument, show, edit, configured, available, logs,
    output: { error: message => errors.push(message), warn: message => errors.push(message), info: message => logs.push(message) }, errors };
}

/** Loads the compiled extension modules with `vscode` resolved to the stub. */
function loadExtension(env) {
  // Cached modules keep the `vscode` stub of the environment that first loaded them.
  const out = path.resolve(__dirname, '../out') + path.sep;
  for (const file of Object.keys(require.cache)) {
    if (file.startsWith(out)) delete require.cache[file];
  }
  const load = Module._load;
  Module._load = function(id, ...args) { return id === 'vscode' ? env.api : load.call(this, id, ...args); };
  try {
    return {
      ...require('../out/inlineCompletionProvider'),
      ...require('../out/nextEditController'),
      ...require('../out/requestCoordinator')
    };
  } finally { Module._load = load; }
}

module.exports = { emitter, Position, Range, Selection, Uri, environment, loadExtension };
