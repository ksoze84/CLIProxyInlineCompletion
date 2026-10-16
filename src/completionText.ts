export function sanitizeCompletion(
	raw: string,
	linePrefix: string,
	suffix: string,
	languageId = 'typescript',
	eol = '\n'
): string {
	let text = raw.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
	const proseDocument = ['markdown', 'plaintext', 'mdx'].includes(languageId);
	if (!proseDocument) {
		const fence = /^```[a-zA-Z0-9_+-]*\n([\s\S]*?)\n```\n?$/.exec(text);
		if (fence && !fence[1].includes('```')) {
			text = fence[1];
		}
		if (/^(?:Here(?:'s| is) (?:the |your )|Sure[,!]|Certainly[,!]|The (?:code|function) (?:above|you)|I (?:can|will) help)/i.test(text)) {
			return '';
		}
	}
	const prefix = linePrefix.trimStart();
	if (prefix.length >= 8 && /\W/.test(prefix) && text.startsWith(prefix)) {
		text = text.slice(prefix.length);
	}
	const suffixHead = suffix.replaceAll('\r\n', '\n').slice(0, 2000);
	for (let size = Math.min(text.length, suffixHead.length); size > 0; size--) {
		const overlap = suffixHead.slice(0, size);
		if (text.endsWith(overlap) && (size >= 3 || /^[\s\])};,]+$/.test(overlap))) {
			text = text.slice(0, -size);
			break;
		}
	}
	return eol === '\r\n' ? text.replaceAll('\n', '\r\n') : text;
}
