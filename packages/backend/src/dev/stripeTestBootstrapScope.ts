import { AsyncLocalStorage } from 'node:async_hooks';

interface ProofIdentity {
  intentId: string;
  merchantId: string;
  providerObjectId: string;
}
/** Only proofs produced within this one bootstrap operation can be reused.
 * No cache survives into another request or the post-payment observation path. */
export function createBootstrapProofScope<T>() {
  const scope = new AsyncLocalStorage<{ proof?: { identity: ProofIdentity; value: T } }>();
  return {
    run<R>(operation: () => Promise<R>): Promise<R> {
      return scope.run({}, operation);
    },
    remember(identity: ProofIdentity, value: T) {
      const current = scope.getStore();
      if (current) current.proof = { identity, value };
    },
    read(
      identity: ProofIdentity,
      observation: { status: string; capabilityPresent: boolean },
    ): T | undefined {
      if (observation.status !== 'created' || observation.capabilityPresent) return undefined;
      const proof = scope.getStore()?.proof;
      return proof &&
        proof.identity.intentId === identity.intentId &&
        proof.identity.merchantId === identity.merchantId &&
        proof.identity.providerObjectId === identity.providerObjectId
        ? proof.value
        : undefined;
    },
  };
}

/** Configuration-bound service objects, never payment snapshots. A changed
 * owner/deployment requires a new process, rather than reusing another owner. */
export function createImmutableRuntimeCache<T>() {
  let cached: { key: string; value: Promise<T> } | undefined;
  return async (key: string, create: () => Promise<T>): Promise<T> => {
    if (cached) {
      if (cached.key !== key) throw new Error('Local billing runtime configuration changed');
      return cached.value;
    }
    const value = Promise.resolve().then(create);
    const entry = { key, value };
    cached = entry;
    try {
      return await value;
    } catch (error) {
      if (cached === entry) cached = undefined;
      throw error;
    }
  };
}
