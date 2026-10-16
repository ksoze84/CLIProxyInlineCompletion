const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeCompletion } = require('../out/completionText');
const { fetchCompletion } = require('../out/cliProxyClient');
const { startServer, reply } = require('./helpers.cjs');
const { RequestCoordinator, waitForIdle } = require('../out/requestCoordinator');
const { contextWindow, isSensitivePath } = require('../out/textContext');
const { EditHistory, buildNextEditRequest, parseNextEdit } = require('../out/nextEdit');
const { fetchNextEdit, safeErrorMessage } = require('../out/cliProxyClient');

test('completion inserts a function body and removes a duplicated suffix', () => {
  assert.equal(sanitizeCompletion('return 1;\n}', '', '\n}'), 'return 1;');
});

test('completion unwraps a model code fence', () => {
  assert.equal(sanitizeCompletion('```ts\nreturn 1;\n```', '', ''), 'return 1;');
});

test('chat transport sends both sides of the cursor and supports typed text parts', async () => {
  const server = await startServer((_entry, response) => reply(response, [{ type: 'text', text: 'value;' }]));
  try {
    const config = { baseUrl: server.baseUrl, model: 'fixture', maxTokens: 256, temperature: 0.1, apiKey: '', systemPrompt: '' };
    const request = { languageId: 'typescript', fileName: 'fixture.ts', prefix: 'return ', suffix: '\n}' };
    assert.equal(await fetchCompletion(config, request, new AbortController().signal), 'value;');
    assert.equal(server.requests[0].url, '/v1/chat/completions');
    assert.equal(server.requests[0].headers.authorization, undefined);
    assert.deepEqual(JSON.parse(server.requests[0].body.messages[1].content), request);
  } finally {
    await server.close();
  }
});

test('reasoning effort is omitted by default and forwarded verbatim when set for both contracts', async () => {
  const server = await startServer((_entry, response) => reply(response, 'value;'));
  try {
    const base = { baseUrl: server.baseUrl, model: 'fixture', maxTokens: 256, temperature: 0.1, apiKey: '' };
    const request = { languageId: 'typescript', fileName: 'fixture.ts', prefix: '', suffix: '' };
    await fetchCompletion(base, request, new AbortController().signal);
    assert.equal('reasoning_effort' in server.requests[0].body, false);
    await fetchCompletion({ ...base, reasoningEffort: 'high' }, request, new AbortController().signal);
    assert.equal(server.requests[1].body.reasoning_effort, 'high');
    await fetchCompletion({ ...base, reasoningEffort: '' }, request, new AbortController().signal);
    assert.equal('reasoning_effort' in server.requests[2].body, false);
    await fetchNextEdit({ ...base, reasoningEffort: 'minimal' }, { window: { text: 'data' } }, new AbortController().signal);
    assert.equal(server.requests[3].body.reasoning_effort, 'minimal');
    await fetchNextEdit(base, { window: { text: 'data' } }, new AbortController().signal);
    assert.equal('reasoning_effort' in server.requests[4].body, false);
  } finally {
    await server.close();
  }
});

test('preserves meaningful whitespace, Markdown fences, EOL and identifier characters', () => {
  assert.equal(sanitizeCompletion('  value  \n    ', '', ''), '  value  \n    ');
  assert.equal(sanitizeCompletion('```js\ncode\n```', '', '', 'markdown'), '```js\ncode\n```');
  assert.equal(sanitizeCompletion('class', '', 'something'), 'class');
  assert.equal(sanitizeCompletion('value;\n  ', '', '', 'typescript', '\r\n'), 'value;\r\n  ');
  assert.equal(sanitizeCompletion('Here is the code:', '', ''), '');
  assert.equal(sanitizeCompletion('Here is the code:', '', '', 'plaintext'), 'Here is the code:');
});

test('context windows respect line boundaries and reject oversized lines', () => {
  const text = 'first\nsecond\nthird\nfourth';
  const window = contextWindow(text, 8, 14);
  assert.ok(window.text.length <= 14);
  assert.equal(text.slice(window.start, window.start + window.text.length), window.text);
  assert.ok(window.text.includes('second'));
  assert.equal(contextWindow('x'.repeat(30), 15, 10), undefined);
  for (const name of ['.env', 'dir/.env.local', '.ssh/id_rsa', 'secret.pem', 'credentials.json']) {
    assert.equal(isSensitivePath(name), true);
  }
  assert.equal(isSensitivePath('src/example.ts'), false);
});

test('new requests abort older requests and automatic NES yields to completion', async () => {
  const coordinator = new RequestCoordinator();
  const first = coordinator.start('completion');
  assert.equal(coordinator.start('automaticNextEdit'), undefined);
  const waiting = waitForIdle(10000, first.signal);
  const second = coordinator.start('nextEdit');
  assert.equal(await waiting, false);
  assert.equal(first.isCurrent(), false);
  first.finish();
  assert.equal(second.isCurrent(), true);
  coordinator.dispose();
  assert.equal(second.isCurrent(), false);
});

test('NES accepts a replacement, anchored insertion and deletion at the exact window offset', () => {
  const window = { start: 20, text: 'return user.name;\n' };
  for (const newText of ['return user.displayName;', 'return user.name;\nlog();', '']) {
    const result = parseNextEdit(JSON.stringify({ edit: { oldText: 'return user.name;', newText } }), window);
    assert.deepEqual(result, { start: 20, end: 37, oldText: 'return user.name;', newText });
  }
});

test('NES rejects ambiguous, invalid, extra, unchanged and excessive edits', () => {
  const window = { start: 0, text: 'same same\nunique' };
  const invalid = [
    '{', '{"edit":null}', '```json\n{"edit":null}\n```',
    JSON.stringify({ edit: { oldText: 'same', newText: 'other' } }),
    JSON.stringify({ edit: { oldText: '', newText: 'other' } }),
    JSON.stringify({ edit: { oldText: 'missing', newText: 'other' } }),
    JSON.stringify({ edit: { oldText: 'unique', newText: 'unique' } }),
    JSON.stringify({ edit: { oldText: 'unique', newText: 'other', command: 'bad' } }),
    JSON.stringify({ edit: { oldText: 'unique', newText: 'x'.repeat(8001) } }),
    JSON.stringify({ edit: { oldText: 'unique', newText: '\n'.repeat(64) } }),
    JSON.stringify({ edit: [{ oldText: 'unique', newText: 'other' }] }),
    JSON.stringify({ edit: null, extra: true })
  ];
  for (const raw of invalid) assert.equal(parseNextEdit(raw, window), undefined, raw.slice(0, 100));
});

test('history interprets multiple changes against the previous snapshot and expires', () => {
  const history = new EditHistory();
  history.record('abc def', 'ABC DEF', [
    { rangeOffset: 0, rangeLength: 3, text: 'ABC' },
    { rangeOffset: 4, rangeLength: 3, text: 'DEF' }
  ], 100);
  assert.equal(history.get(100)[0].changes[1].oldText, 'def');
  assert.equal(history.get(60101).length, 0);
  for (let index = 0; index < 20; index++) history.record('a', 'b', [{ rangeOffset: 0, rangeLength: 1, text: 'b' }], 60200);
  assert.equal(history.get(60200).length, 16);
  history.record('a', 'invalid', [{ rangeOffset: 0, rangeLength: 1, text: 'b' }], 60300);
  assert.equal(history.get(60300).length, 0);
  history.record('', 'x'.repeat(7000), [{ rangeOffset: 0, rangeLength: 0, text: 'x'.repeat(7000) }]);
  assert.equal(history.get().length, 0);
});

test('NES payload is bounded including JSON escaping and cannot invent edit history', () => {
  assert.equal(buildNextEditRequest('typescript', 'file.ts', 'x', 0, []), undefined);
  const history = [{ time: Date.now(), changes: [{ offset: 0, oldText: 'x', newText: 'y' }] }];
  const text = ('"\\\t'.repeat(500) + '\n').repeat(50);
  const result = buildNextEditRequest('typescript', 'file.ts', text, 0, history);
  assert.ok(result);
  assert.ok(JSON.stringify(result).length <= 22000);
  assert.equal(text.slice(result.window.start, result.window.start + result.window.text.length), result.window.text);
});

test('NES has a separate contract and output budget; errors never contain backend content', async () => {
  const server = await startServer((entry, response) => {
    if (entry.body.model === 'failure') {
      response.writeHead(500);
      response.end('secret echoed prompt');
    } else reply(response, '{"edit":null}');
  });
  try {
    const config = { baseUrl: server.baseUrl, model: 'fixture', temperature: 0.1, apiKey: 'test-token' };
    assert.equal(await fetchNextEdit(config, { window: { text: 'data' } }, new AbortController().signal), '{"edit":null}');
    assert.equal(server.requests[0].body.max_tokens, 1024);
    assert.equal(server.requests[0].headers.authorization, 'Bearer test-token');
    assert.equal(server.requests[0].body.response_format, undefined);
    await assert.rejects(fetchNextEdit({ ...config, model: 'failure' }, {}, new AbortController().signal), error => {
      assert.equal(safeErrorMessage(error), 'CLIProxyApi returned HTTP 500');
      return true;
    });
    assert.ok(!safeErrorMessage(new Error('secret')).includes('secret'));
  } finally { await server.close(); }
});

test('transport discards truncated responses and aborts an in-flight request', async () => {
  let responseStarted;
  const started = new Promise(resolve => { responseStarted = resolve; });
  const server = await startServer((entry, response) => {
    if (entry.body.model === 'slow') {
      responseStarted();
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: 'truncated' } }] }));
  });
  try {
    const config = { baseUrl: server.baseUrl, model: 'fixture', maxTokens: 256, temperature: 0.1, apiKey: '', systemPrompt: '' };
    const request = { languageId: 'typescript', fileName: 'fixture.ts', prefix: '', suffix: '' };
    assert.equal(await fetchCompletion(config, request, new AbortController().signal), '');
    const controller = new AbortController();
    const result = fetchCompletion({ ...config, model: 'slow' }, request, controller.signal);
    await started;
    controller.abort();
    await assert.rejects(result, error => error.name === 'AbortError');
  } finally { await server.close(); }
});

test('context preserves surrogate pairs and treats an initial newline correctly', () => {
  const text = '\nalpha\nemoji: \u{1f600}\nlast';
  assert.equal(contextWindow(text, 0, 1).text, '\n');
  const window = contextWindow(text, 12, 20);
  assert.ok(window.text.includes('\u{1f600}'));
  assert.equal(window.text.includes('\ufffd'), false);
  const crlf = 'first\r\nsecond\r\nthird';
  const crlfWindow = contextWindow(crlf, 8, 10);
  assert.equal(crlfWindow.text, 'second\r\n');
});