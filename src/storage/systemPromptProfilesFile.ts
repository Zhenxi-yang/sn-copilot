import {decodeUtf8, encodeUtf8} from '../sdk/utf8';
import type {Logger} from '../sdk/types';
import {DEFAULT_KEY_ROOT} from './keyFiles';
import type {FileIo} from './fileIo';

export type SystemPromptProfile = {
  id: string;
  label: string;
  prompt: string;
};

export type SystemPromptProfileState = {
  activeId: string | null;
  profiles: SystemPromptProfile[];
};

export const SYSTEM_PROMPTS_FILENAME = 'system_prompts.txt';
export const SYSTEM_PROMPTS_PATH = `${DEFAULT_KEY_ROOT}/${SYSTEM_PROMPTS_FILENAME}`;

const TAG = '[systemPrompts]';
const NOOP = (): void => undefined;
const noopLogger: Logger = {log: NOOP, warn: NOOP, error: NOOP};

export type SystemPromptProfilesDeps = {
  io: FileIo;
  systemPromptsPath?: string;
  logger?: Logger;
};

const pathOf = (deps: SystemPromptProfilesDeps): string =>
  deps.systemPromptsPath ?? SYSTEM_PROMPTS_PATH;

const parseLine = (line: string): {active: boolean; label: string; prompt: string} | null => {
  const active = line.startsWith('*');
  const body = active ? line.slice(1).trim() : line;
  const sep = body.indexOf(':');
  if (sep <= 0) {
    return null;
  }
  const label = body.slice(0, sep).trim();
  const prompt = body.slice(sep + 1).trim();
  if (label.length === 0 || prompt.length === 0) {
    return null;
  }
  return {active, label, prompt};
};

export const parseSystemPromptProfilesText = (
  text: string,
  logger: Logger = noopLogger,
): SystemPromptProfileState => {
  const profiles: SystemPromptProfile[] = [];
  let activeId: string | null = null;
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const parsed = parseLine(line);
    if (parsed === null) {
      logger.warn(`${TAG} skipping malformed line "${line}"`);
      continue;
    }
    const id = `profile-${profiles.length + 1}`;
    profiles.push({id, label: parsed.label, prompt: parsed.prompt});
    if (parsed.active || activeId === null) {
      activeId = id;
    }
  }
  return {activeId, profiles};
};

export const readSystemPromptProfiles = async (
  deps: SystemPromptProfilesDeps,
): Promise<SystemPromptProfileState> => {
  const logger = deps.logger ?? noopLogger;
  const bytes = await deps.io.readBytes(pathOf(deps));
  if (bytes === null || bytes.length === 0) {
    return {activeId: null, profiles: []};
  }
  try {
    const text = decodeUtf8(bytes);
    return parseSystemPromptProfilesText(text, logger);
  } catch (e) {
    logger.warn(`${TAG} decode failed (${(e as Error).message})`);
    return {activeId: null, profiles: []};
  }
};

const toFileText = (state: SystemPromptProfileState): string =>
  state.profiles
    .map((p) => `${p.id === state.activeId ? '* ' : ''}${p.label}: ${p.prompt}`)
    .join('\n')
    .concat('\n');

export const setActiveSystemPromptProfile = async (
  deps: SystemPromptProfilesDeps,
  activeId: string,
): Promise<SystemPromptProfileState> => {
  const state = await readSystemPromptProfiles(deps);
  if (!state.profiles.some((p) => p.id === activeId)) {
    return state;
  }
  const next: SystemPromptProfileState = {profiles: state.profiles, activeId};
  await deps.io.writeBytes(pathOf(deps), encodeUtf8(toFileText(next)));
  return next;
};
