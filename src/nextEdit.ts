export interface ContentChange {
	rangeOffset: number;
	rangeLength: number;
	text: string;
}

/** A recent change shown as whole lines; `line` is 1-based in the document when it was made. */
export interface LineEdit {
	line: number;
	before: string;
	after: string;
}

interface Change {
	offset: number;
	oldText: string;
	newText: string;
	edit: LineEdit;
}

interface Entry {
	time: number;
	changes: Change[];
}

export function lineNumber(text: string, offset: number): number {
	let line = 1;
	for (let index = text.indexOf('\n'); index >= 0 && index < offset; index = text.indexOf('\n', index + 1)) {
		line++;
	}
	return line;
}

function describe(text: string, start: number, end: number, oldText: string, newText: string): Change {
	const lineStart = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1;
	let lineEnd = text.indexOf('\n', end);
	if (lineEnd < 0) {
		lineEnd = text.length;
	} else if (lineEnd > end && text[lineEnd - 1] === '\r') {
		lineEnd--;
	}
	const prefix = text.slice(lineStart, start);
	const suffix = text.slice(end, lineEnd);
	return {
		offset: start,
		oldText,
		newText,
		edit: { line: lineNumber(text, start), before: prefix + oldText + suffix, after: prefix + newText + suffix }
	};
}

// `before` is the document after `previous`, so its region is [offset, offset + newText.length).
function merge(before: string, previous: Change, change: ContentChange): Change | undefined {
	const end = previous.offset + previous.newText.length;
	const changeEnd = change.rangeOffset + change.rangeLength;
	if (change.rangeOffset > end || changeEnd < previous.offset) {
		return undefined;
	}
	const start = Math.min(previous.offset, change.rangeOffset);
	const stop = Math.max(end, changeEnd);
	return describe(before, start, stop,
		before.slice(start, previous.offset) + previous.oldText + before.slice(end, stop),
		before.slice(start, change.rangeOffset) + change.text + before.slice(changeEnd, stop));
}

export class EditHistory {
	private entries: Entry[] = [];

	record(before: string, after: string, changes: readonly ContentChange[], now = Date.now()): void {
		const sorted = [...changes].sort((first, second) => second.rangeOffset - first.rangeOffset);
		let reconstructed = before;
		let boundary = before.length;
		for (const change of sorted) {
			if (change.rangeOffset < 0 || change.rangeLength < 0 || change.rangeOffset + change.rangeLength > boundary) {
				this.clear();
				return;
			}
			reconstructed = reconstructed.slice(0, change.rangeOffset) + change.text
				+ reconstructed.slice(change.rangeOffset + change.rangeLength);
			boundary = change.rangeOffset;
		}
		if (reconstructed !== after) {
			this.clear();
			return;
		}
		const last = this.entries.at(-1);
		const merged = changes.length === 1 && last?.changes.length === 1
			? merge(before, last.changes[0], changes[0])
			: undefined;
		if (merged) {
			this.entries.pop();
			if (merged.oldText !== merged.newText) {
				this.entries.push({ time: now, changes: [merged] });
			}
		} else if (changes.length > 0) {
			this.entries.push({ time: now, changes: changes.map(change => describe(before, change.rangeOffset,
				change.rangeOffset + change.rangeLength,
				before.slice(change.rangeOffset, change.rangeOffset + change.rangeLength), change.text)) });
		}
		this.prune(now);
	}

	get(now = Date.now()): LineEdit[] {
		this.prune(now);
		return this.edits();
	}

	clear(): void {
		this.entries = [];
	}

	private edits(): LineEdit[] {
		return this.entries.flatMap(entry => entry.changes.map(change => change.edit));
	}

	private prune(now: number): void {
		this.entries = this.entries.filter(entry => now - entry.time <= 60000).slice(-16);
	}
}

export interface NextEditRequest {
	languageId: string;
	fileName: string;
	cursor: { line: number; column: number };
	document: string;
	recentEdits: LineEdit[];
}

/** The whole document is sent; the model's context window is the only size limit. */
export function buildNextEditRequest(
	languageId: string,
	fileName: string,
	text: string,
	cursorOffset: number,
	recentEdits: LineEdit[]
): NextEditRequest | undefined {
	if (recentEdits.length === 0) {
		return undefined;
	}
	const lineStart = cursorOffset === 0 ? 0 : text.lastIndexOf('\n', cursorOffset - 1) + 1;
	const cursor = { line: lineNumber(text, cursorOffset), column: cursorOffset - lineStart + 1 };
	return { languageId, fileName, cursor, document: text, recentEdits };
}

export interface PredictedEdit {
	start: number;
	end: number;
	oldText: string;
	newText: string;
}

function hasKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		&& Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export type NextEditRejection = 'empty' | 'too-large' | 'invalid-json' | 'invalid-shape' | 'null'
	| 'unchanged' | 'anchor-missing' | 'anchor-ambiguous';

const FENCE = /^\s*```(?:json)?[ \t]*\r?\n([\s\S]*)\r?\n[ \t]*```\s*$/;

export function parseNextEdit(raw: string, text: string): PredictedEdit | NextEditRejection {
	if (raw.trim() === '') {
		return 'empty';
	}
	if (raw.length > 100000) {
		return 'too-large';
	}
	let payload: unknown;
	try {
		payload = JSON.parse(FENCE.exec(raw)?.[1] ?? raw);
	} catch {
		return 'invalid-json';
	}
	if (!hasKeys(payload, ['edit'])) {
		return 'invalid-shape';
	}
	if (payload.edit === null) {
		return 'null';
	}
	if (!hasKeys(payload.edit, ['oldText', 'newText'])) {
		return 'invalid-shape';
	}
	const { oldText, newText } = payload.edit;
	if (typeof oldText !== 'string' || typeof newText !== 'string' || oldText.length === 0) {
		return 'invalid-shape';
	}
	if (oldText === newText) {
		return 'unchanged';
	}
	if (oldText.length > 8000 || newText.length > 8000
		|| oldText.split('\n').length > 64 || newText.split('\n').length > 64) {
		return 'too-large';
	}
	const offset = text.indexOf(oldText);
	if (offset < 0) {
		return 'anchor-missing';
	}
	if (text.includes(oldText, offset + 1)) {
		return 'anchor-ambiguous';
	}
	return { start: offset, end: offset + oldText.length, oldText, newText };
}