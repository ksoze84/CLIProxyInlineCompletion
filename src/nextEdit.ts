import { CONTEXT_LIMIT, contextWindow } from './textContext';

export interface ContentChange {
	rangeOffset: number;
	rangeLength: number;
	text: string;
}

export interface RecentEdit {
	time: number;
	changes: Array<{ offset: number; oldText: string; newText: string }>;
}

export class EditHistory {
	private entries: RecentEdit[] = [];

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
		if (changes.length > 0) {
			this.entries.push({ time: now, changes: changes.map(change => ({
				offset: change.rangeOffset,
				oldText: before.slice(change.rangeOffset, change.rangeOffset + change.rangeLength),
				newText: change.text
			})) });
		}
		this.prune(now);
	}

	get(now = Date.now()): RecentEdit[] {
		this.prune(now);
		return [...this.entries];
	}

	clear(): void {
		this.entries = [];
	}

	private prune(now: number): void {
		this.entries = this.entries.filter(entry => now - entry.time <= 60000).slice(-16);
		while (JSON.stringify(this.entries).length > 6000) {
			this.entries.shift();
		}
	}
}

export interface NextEditRequest {
	languageId: string;
	fileName: string;
	cursorOffset: number;
	window: { start: number; text: string };
	recentEdits: RecentEdit[];
}

export function buildNextEditRequest(
	languageId: string,
	fileName: string,
	text: string,
	cursorOffset: number,
	recentEdits: RecentEdit[]
): NextEditRequest | undefined {
	if (recentEdits.length === 0) {
		return undefined;
	}
	let budget = CONTEXT_LIMIT - JSON.stringify(recentEdits).length - 3000;
	while (budget > 0) {
		const window = contextWindow(text, cursorOffset, budget);
		if (!window) {
			return undefined;
		}
		const request = { languageId, fileName, cursorOffset, window, recentEdits };
		if (JSON.stringify(request).length <= CONTEXT_LIMIT - 2000) {
			return request;
		}
		budget = Math.floor(budget / 2);
	}
	return undefined;
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

export function parseNextEdit(raw: string, window: { start: number; text: string }): PredictedEdit | undefined {
	if (raw.length > 100000) {
		return undefined;
	}
	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!hasKeys(payload, ['edit']) || !hasKeys(payload.edit, ['oldText', 'newText'])) {
		return undefined;
	}
	const { oldText, newText } = payload.edit;
	if (typeof oldText !== 'string' || typeof newText !== 'string' || oldText.length === 0
		|| oldText === newText || oldText.length > 8000 || newText.length > 8000
		|| oldText.split('\n').length > 64 || newText.split('\n').length > 64) {
		return undefined;
	}
	const offset = window.text.indexOf(oldText);
	if (offset < 0 || window.text.includes(oldText, offset + 1)) {
		return undefined;
	}
	return { start: window.start + offset, end: window.start + offset + oldText.length, oldText, newText };
}