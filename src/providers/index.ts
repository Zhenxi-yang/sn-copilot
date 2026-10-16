/**
 * Provider registry — pick a concrete `ProviderClient` for the
 * resolved provider id. The `fetchFn` indirection lets tests inject
 * a mocked fetch routed by URL.
 */

import {createDeepSeekClient} from './deepseek';
import type {ProviderClient, ProviderId} from './ProviderClient';

export const createProviderClient = (
  id: ProviderId,
  fetchFn: typeof fetch = globalThis.fetch,
): ProviderClient => {
  if (id !== 'deepseek') {
    throw new Error(`Unsupported provider: ${id}`);
  }
  return createDeepSeekClient(fetchFn);
};
