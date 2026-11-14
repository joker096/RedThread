export type SessionMutation = (isCurrent: () => boolean) => Promise<boolean | void> | boolean | void;

/**
 * Serializes secure-session writes/removals and fences work started by an
 * earlier authenticated session. Invalidation is synchronous; queued work
 * checks its generation immediately before it touches secure storage.
 */
export function createSessionMutationQueue() {
  let generation = 0;
  let tail: Promise<void> = Promise.resolve();

  return {
    currentGeneration(): number {
      return generation;
    },
    isCurrent(expectedGeneration: number): boolean {
      return Number.isSafeInteger(expectedGeneration) && expectedGeneration === generation;
    },
    invalidate(): number {
      generation += 1;
      return generation;
    },
    run<T>(
      expectedGeneration: number | undefined,
      operation: (isCurrent: () => boolean) => Promise<T> | T
    ): Promise<T | false> {
      const task = tail.then(async () => {
        if (expectedGeneration !== undefined && expectedGeneration !== generation) return false;
        const isCurrent = () => expectedGeneration === undefined || expectedGeneration === generation;
        const result = await operation(isCurrent);
        return isCurrent() ? result : false;
      });
      tail = task.then(() => undefined, () => undefined);
      return task;
    }
  };
}
