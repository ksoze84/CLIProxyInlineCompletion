export type RequestKind = 'completion' | 'nextEdit' | 'automaticNextEdit';

export class RequestCoordinator {
	private active: { kind: RequestKind; controller: AbortController } | undefined;

	start(kind: RequestKind) {
		if (kind === 'automaticNextEdit' && this.active) {
			return undefined;
		}
		this.cancel();
		const entry = { kind, controller: new AbortController() };
		this.active = entry;
		return {
			signal: entry.controller.signal,
			cancel: () => entry.controller.abort(),
			isCurrent: () => this.active === entry && !entry.controller.signal.aborted,
			finish: () => {
				if (this.active === entry) {
					this.active = undefined;
				}
			}
		};
	}

	cancel(): void {
		this.active?.controller.abort();
		this.active = undefined;
	}

	dispose(): void {
		this.cancel();
	}
}

export function waitForIdle(ms: number, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) {
		return Promise.resolve(false);
	}
	return new Promise(resolve => {
		const finish = (ready: boolean) => {
			clearTimeout(timer);
			signal.removeEventListener('abort', abort);
			resolve(ready);
		};
		const abort = () => finish(false);
		const timer = setTimeout(() => finish(true), ms);
		signal.addEventListener('abort', abort, { once: true });
	});
}