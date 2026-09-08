import type {
  EnsureOptions,
  EnqueueOptions,
  RunAvailableResult,
  ProcessResult,
  ExternalRunAvailableResult,
  ExternalProcessResult,
  FollowUpOptions,
  WorkDefinition,
} from '../../src/index.js';
import type { ExternalProcessResult as ExternalSubpathResult } from '../../src/external.js';

type Equal<A, B> = [A, B] extends [B, A] ? true : false;
type Assert<T extends true> = T;
type OptionAliases = Assert<Equal<EnsureOptions, EnqueueOptions>>;
type LocalResultAliases = Assert<Equal<RunAvailableResult<number>, ProcessResult<number>>>;
type ExternalResultAliases = Assert<
  Equal<ExternalRunAvailableResult<number>, ExternalProcessResult<number>>
>;
type ExternalSubpathAliases = Assert<
  Equal<ExternalProcessResult<number>, ExternalSubpathResult<number>>
>;

const conventionalBounds: EnqueueOptions = { limits: { maxAttempts: 2 } };
const readableBounds: EnsureOptions = { executionLimits: { maxAttempts: 2 } };
const conventionalDefinition: WorkDefinition<null, string> = {
  limits: { leaseMs: 1000 },
  defer: { afterMs: 5 },
  next: () => [],
};
const readableDefinition: WorkDefinition<null, string> = {
  executionLimits: { leaseMs: 1000 },
  wait: { afterMs: 5 },
  thenDo: () => [],
};
const conventionalFollowups: FollowUpOptions = { next: [] };
const readableFollowups: FollowUpOptions = { thenDo: [] };
void [
  conventionalBounds,
  readableBounds,
  conventionalDefinition,
  readableDefinition,
  conventionalFollowups,
  readableFollowups,
];
