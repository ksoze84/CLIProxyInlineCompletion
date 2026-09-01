const FENCE = /^\s*```[^\n]*\n?([\s\S]*?)\n?\s*```\s*$/;

/** Models often answer with a fenced block even when told not to. */
function stripCodeFence(text: string): string {
	const match = FENCE.exec(text);
	return match ? match[1] : text;
}

function stripEchoedPrefix(completion: string, linePrefix: string): string {
	const trimmedLine = linePrefix.trimStart();
	if (trimmedLine.length > 0 && completion.startsWith(trimmedLine)) {
		return completion.slice(trimmedLine.length);
	}
	return completion;
}

/** Avoid duplicating text the document already has after the cursor. */
function trimOverlapWithSuffix(completion: string, suffix: string): string {
	const suffixHead = suffix.slice(0, 200);
	if (suffixHead.length === 0) {
		return completion;
	}
	const maxOverlap = Math.min(completion.length, suffixHead.length);
	for (let size = maxOverlap; size > 0; size--) {
		if (completion.endsWith(suffixHead.slice(0, size))) {
			return completion.slice(0, completion.length - size);
		}
	}
	return completion;
}

export function sanitizeCompletion(raw: string, linePrefix: string, suffix: string): string {
	let text = stripCodeFence(raw.replace(/^\uFEFF/, ''));
	text = text.replace(/\r\n/g, '\n');
	text = stripEchoedPrefix(text, linePrefix);
	text = trimOverlapWithSuffix(text, suffix);
	return text.replace(/\s+$/, '');
}
