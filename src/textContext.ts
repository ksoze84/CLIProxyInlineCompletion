export const CONTEXT_LIMIT = 24000;

function endOfLine(text: string, offset: number): number {
	const nextBreak = text.indexOf('\n', offset);
	return nextBreak < 0 ? text.length : nextBreak + 1;
}

export function contextWindow(text: string, offset: number, budget: number): { text: string; start: number } | undefined {
	const lineStart = offset === 0 ? 0 : text.lastIndexOf('\n', offset - 1) + 1;
	const lineEnd = endOfLine(text, offset);
	if (lineEnd - lineStart > budget) {
		return undefined;
	}
	let start = lineStart;
	let end = lineEnd;
	let before = true;
	while (true) {
		const previous = start > 0 ? text.lastIndexOf('\n', start - 2) + 1 : start;
		const following = endOfLine(text, end);
		const expansions = [{ start: previous, end }, { start, end: following }];
		if (!before) {
			expansions.reverse();
		}
		const expanded = expansions.find(candidate => candidate.end - candidate.start <= budget
			&& (candidate.start < start || candidate.end > end));
		if (!expanded) {
			break;
		}
		start = expanded.start;
		end = expanded.end;
		before = !before;
	}
	return { text: text.slice(start, end), start };
}

export function isSensitivePath(fileName: string): boolean {
	const parts = fileName.toLowerCase().split(/[\\/]/);
	return parts.some(part => part === '.env' || part.startsWith('.env.') || part === '.ssh'
		|| part === 'credentials' || part.startsWith('credentials.')
		|| ['id_rsa', 'id_ed25519', 'id_ecdsa'].includes(part))
		|| /\.(?:pem|key|p12|pfx)$/i.test(fileName);
}