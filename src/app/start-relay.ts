/**
 * Starts `relay` and reports how it settled: `onReady` once it resolves, `onFail` with the reason
 * once it rejects. `relayWorker` returns a promise (@fkn/lib 0.9.41 and later), so its failures are
 * rejections and a synchronous try/catch around the call never sees one.
 */
export const startRelay = (
  relay: () => Promise<void>,
  onReady: () => void,
  onFail: (reason: unknown) => void,
): Promise<void> => relay().then(onReady, onFail)
