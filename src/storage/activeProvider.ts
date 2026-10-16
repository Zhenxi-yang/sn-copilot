// Resolves which provider is active given the discovered key files.
// Pure function — no IO, fully unit-testable.
//
// Rules:
//   1. Zero key files      → 'none' with setup message.
//   2. Exactly one key file → that provider.
//   3. Two or more files   → ambiguous (DeepSeek-only mode expects one file).

import type {KeyFile, ProviderResolution} from '../types';
import type {AppState} from './appState';

export const resolveActiveProvider = (files: KeyFile[]): ProviderResolution => {
  const deepseekFiles = files.filter((f) => f.provider === 'deepseek');
  if (deepseekFiles.length === 0) {
    return {
      kind: 'none',
      message:
        'No DeepSeek key file found. Drop copilot-key-deepseek.txt in MyStyle/SnCopilot/ to enable Copilot.',
    };
  }
  if (deepseekFiles.length === 1) {
    return {
      kind: 'ok',
      active: deepseekFiles[0],
      others: files.filter((f) => f !== deepseekFiles[0]),
    };
  }
  return {
    kind: 'ambiguous',
    message: 'Multiple DeepSeek key files found. Keep only one copilot-key-deepseek.txt.',
    candidates: deepseekFiles,
  };
};

// The key file to talk to the provider with, in the key store's current
// state: none while the state is loading, locked, mid-merge or has no key,
// and none when the key files don't resolve to one active provider.
export const activeKeyFromState = (
  state: AppState | null,
): KeyFile | undefined => {
  if (
    state === null ||
    !(
      state.kind === 'unlocked' ||
      state.kind === 'plaintext' ||
      state.kind === 'migrate'
    )
  ) {
    return undefined;
  }
  const r = resolveActiveProvider(state.files);
  return r.kind === 'ok' ? r.active : undefined;
};
