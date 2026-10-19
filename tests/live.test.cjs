// Opt-in tests against a real CLIProxyApi. Only synthetic fixture code below is sent to the models.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Position, Selection, environment, loadExtension } = require('./vscodeStub.cjs');
const { fetchCompletion, fetchNextEdit } = require('../out/cliProxyClient');
const { EditHistory, buildNextEditRequest, parseNextEdit } = require('../out/nextEdit');

const baseUrl = process.env.CLIPROXY_LIVE_URL;
const live = {
  baseUrl,
  apiKey: process.env.CLIPROXY_API_KEY || '',
  model: process.env.CLIPROXY_LIVE_MODEL || 'openrouter.ai/mistralai/codestral-2508',
  reasoningEffort: 'low',
  nextEditsModel: process.env.CLIPROXY_LIVE_NES_MODEL || 'gemini-3.5-flash-lite',
  nextEditsReasoningEffort: 'low',
  maxTokens: 256,
  temperature: 0.1,
  systemPrompt: ''
};
const skip = baseUrl ? false : 'set CLIPROXY_LIVE_URL (and CLIPROXY_API_KEY) to run live tests';
const attempts = Number(process.env.CLIPROXY_LIVE_ATTEMPTS || 3);
const timeout = () => AbortSignal.timeout(30000);

function typing(offset, removed, inserted) {
  if (inserted.length === 0) {
    return Array.from({ length: removed }, (_, index) => ({ rangeOffset: offset + removed - 1 - index, rangeLength: 1, text: '' }));
  }
  return [...inserted].map((char, index) => ({ rangeOffset: offset + index, rangeLength: index === 0 ? removed : 0, text: char }));
}

const scenarios = [
  {
    name: 'renamed function updates its call',
    text: "function name(user: User): string {\n\treturn user.first + ' ' + user.last;\n}\n\nexport function greet(user: User): string {\n\treturn 'Hello, ' + name(user);\n}\n",
    edit: text => typing(text.indexOf('name'), 4, 'fullName'),
    check: text => text.includes("'Hello, ' + fullName(user)")
  },
  {
    name: 'new interface field is used in a calculation',
    text: 'interface Point {\n\tx: number;\n\ty: number;\n}\n\nfunction length(point: Point): number {\n\treturn Math.sqrt(point.x * point.x + point.y * point.y);\n}\n',
    edit: text => typing(text.indexOf('\n}'), 0, '\n\tz: number;'),
    check: text => text.includes('point.z')
  },
  {
    name: 'renamed property updates its use',
    text: 'const settings = {\n\ttimeout: 1000,\n\tretries: 3\n};\n\nexport function connect() {\n\treturn open(settings.timeout, settings.retries);\n}\n',
    edit: text => typing(text.indexOf('timeout') + 7, 0, 'Ms'),
    check: text => text.includes('settings.timeoutMs')
  },
  {
    name: 'removed parameter is removed from a call',
    text: "function log(message: string, verbose: boolean) {\n\tconsole.log(message);\n}\n\nlog('start', true);\nlog('done', false);\n",
    edit: text => typing(text.indexOf(', verbose'), ', verbose: boolean'.length, ''),
    check: text => text.includes("log('start');") || text.includes("log('done');")
  }
];

// Models are nondeterministic: a scenario passes if any of a few attempts produces the expected edit.
async function eventually(name, attempt) {
  const outcomes = [];
  for (let index = 0; index < attempts; index++) {
    const outcome = await attempt();
    outcomes.push(outcome);
    if (outcome === 'ok') {
      console.log(`  ${name}: ok after ${index + 1} attempt(s)`);
      return;
    }
  }
  assert.fail(`${name}: ${outcomes.join(', ')}`);
}

test('live: inline completion model fills the gap at the cursor', { skip }, async () => {
  const request = {
    languageId: 'typescript',
    fileName: 'src/math.ts',
    prefix: 'export function add(a: number, b: number): number {\n\treturn ',
    suffix: '\n}\n'
  };
  await eventually('completion', async () => {
    const completion = await fetchCompletion(live, request, timeout());
    return /a\s*\+\s*b|b\s*\+\s*a/.test(completion) && !completion.includes('```') ? 'ok' : JSON.stringify(completion.slice(0, 80));
  });
});

for (const scenario of scenarios) {
  test(`live NES: ${scenario.name}`, { skip }, async () => {
    await eventually(scenario.name, async () => {
      const history = new EditHistory();
      let text = scenario.text;
      let cursor = 0;
      for (const change of scenario.edit(text)) {
        const before = text;
        text = before.slice(0, change.rangeOffset) + change.text + before.slice(change.rangeOffset + change.rangeLength);
        cursor = change.rangeOffset + change.text.length;
        history.record(before, text, [change]);
      }
      assert.equal(history.get().length, 1, 'typing is grouped into one edit');
      const request = buildNextEditRequest('typescript', 'src/example.ts', text, cursor, history.get());
      const { content, truncated } = await fetchNextEdit(live, request, timeout());
      if (truncated) return 'truncated';
      const edit = parseNextEdit(content, text);
      if (typeof edit === 'string') return edit;
      return scenario.check(text.slice(0, edit.start) + edit.newText + text.slice(edit.end)) ? 'ok' : 'wrong-edit';
    });
  });
}

test('live: automatic NES fires while the completion model is in flight', { skip }, async () => {
  const env = environment();
  for (const [key, value] of Object.entries({
    baseUrl: live.baseUrl, apiKey: live.apiKey, model: live.model, reasoningEffort: 'low',
    'nextEdits.model': live.nextEditsModel, 'nextEdits.reasoningEffort': 'low',
    'nextEdits.automatic': true, debounceMs: 300, requestTimeoutMs: 30000
  })) env.settings.set(key, value);
  const { CliProxyInlineCompletionProvider, NextEditController, RequestCoordinator } = loadExtension(env);
  const requests = new RequestCoordinator();
  const controller = new NextEditController(env.output, requests);
  const provider = new CliProxyInlineCompletionProvider(env.output, requests, doc => controller.hasCandidate(doc));
  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  const automaticContext = { triggerKind: 1, selectedCompletionInfo: undefined };
  try {
    await eventually('automatic', async () => {
      const source = env.makeDocument(scenarios[0].text);
      const editor = await env.show(source);
      const available = env.available(30000).then(() => 'ok', () => 'timeout');
      for (const change of scenarios[0].edit(source.text)) {
        env.edit(source, change.rangeOffset, change.rangeLength, change.text);
        const position = source.positionAt(change.rangeOffset + change.text.length);
        editor.selection = new Selection(position, position);
        // Like VS Code: every keystroke asks the inline completion provider.
        void provider.provideInlineCompletionItems(source, position, automaticContext, token);
      }
      env.api.executed.length = 0;
      const outcome = await available;
      if (outcome === 'ok') {
        assert.ok(env.api.executed.includes('editor.action.inlineSuggest.hide'), 'ghost text is hidden');
        const position = editor.selection.active;
        const blocked = await provider.provideInlineCompletionItems(source, position, automaticContext, token);
        assert.equal(blocked, undefined, 'no ghost text competes for Tab while a next edit is shown');
        await env.api.commands.executeCommand('cliproxyInline.acceptNextEdit');
        return scenarios[0].check(source.text) ? 'ok' : 'wrong-edit';
      }
      return `${outcome} [${env.logs.filter(line => line.startsWith('Next edit')).slice(-1).join('')}]`;
    });
    assert.ok(env.logs.some(line => /^Next edit automatic: ok \(\d+ ms, model \d+ ms\)$/.test(line)));
    console.log(`  ${env.logs.filter(line => line.startsWith('Next edit')).join('\n  ')}`);
  } finally {
    controller.dispose();
    provider.reset();
    requests.dispose();
  }
});

test('live: accepting a next edit chains the next one across a rename with several uses', { skip }, async () => {
  const env = environment();
  for (const [key, value] of Object.entries({
    baseUrl: live.baseUrl, apiKey: live.apiKey, model: live.model, reasoningEffort: 'low',
    'nextEdits.model': live.nextEditsModel, 'nextEdits.reasoningEffort': 'low', requestTimeoutMs: 30000
  })) env.settings.set(key, value);
  const { NextEditController, RequestCoordinator } = loadExtension(env);
  const requests = new RequestCoordinator();
  const controller = new NextEditController(env.output, requests);
  // Uses are far apart so one contiguous edit cannot fix them all and a chain is needed.
  const filler = name => `export function ${name}() {\n${Array.from({ length: 70 }, (_, i) => `\tconsole.log('${name} ${i}');\n`).join('')}}\n\n`;
  const text = "function total(items: number[]): number {\n\treturn items.reduce((sum, item) => sum + item, 0);\n}\n\n"
    + filler('header') + 'export const cart = total([1, 2]);\n\n' + filler('body') + 'export const invoice = total([5, 6]);\n';
  const stale = source => (source.text.match(/= total\(/g) || []).length;
  try {
    await eventually('chained', async () => {
      env.logs.length = 0;
      const source = env.makeDocument(text);
      const editor = await env.show(source);
      for (const change of typing(text.indexOf('total'), 5, 'sumAll')) {
        env.edit(source, change.rangeOffset, change.rangeLength, change.text);
        const position = source.positionAt(change.rangeOffset + change.text.length);
        editor.selection = new Selection(position, position);
      }
      const first = env.available(30000);
      await env.api.commands.executeCommand('cliproxyInline.triggerNextEdit');
      if (!(await first.then(() => true, () => false))) return `no first edit [${env.logs.at(-1)}]`;
      await env.api.commands.executeCommand('cliproxyInline.acceptNextEdit');
      if (stale(source) !== 1) return `first edit left ${stale(source)} stale calls`;
      // Registered after accepting: showing the source editor re-announces the old candidate.
      const chained = env.available(30000).then(() => true, () => false);
      if (!(await chained)) return `no chained edit [${env.logs.at(-1)}]`;
      await env.api.commands.executeCommand('cliproxyInline.acceptNextEdit');
      return stale(source) === 0 && env.logs.some(line => /^Next edit chained: ok /.test(line)) ? 'ok' : 'chained edit did not fix the last call';
    });
    console.log(`  ${env.logs.filter(line => line.startsWith('Next edit')).join('\n  ')}`);
  } finally {
    controller.dispose();
    requests.dispose();
  }
});
