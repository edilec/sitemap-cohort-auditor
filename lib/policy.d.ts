export interface PolicyInput {
  schemaVersion: 1;
  allowedHosts?: string[];
  allowedSchemes?: string[];
  minUniqueUrls?: number;
  minUniqueImages?: number;
  maxDuplicateUrls?: number;
  maxDuplicateUrlEntries?: number;
  maxInvalidLastmodValues?: number;
  maxFragmentUrls?: number;
  maxInvalidUrls?: number;
  maxMissingLocs?: number;
  maxRemovedUrls?: number;
}

export interface Policy {
  readonly schemaVersion: 1;
  readonly allowedHosts?: readonly string[];
  readonly allowedSchemes?: readonly string[];
  readonly minUniqueUrls?: number;
  readonly minUniqueImages?: number;
  readonly maxDuplicateUrls?: number;
  readonly maxDuplicateUrlEntries?: number;
  readonly maxInvalidLastmodValues?: number;
  readonly maxFragmentUrls?: number;
  readonly maxInvalidUrls?: number;
  readonly maxMissingLocs?: number;
  readonly maxRemovedUrls?: number;
}

export interface PolicySummary {
  uniqueUrls: number;
  uniqueImages: number;
  duplicateUrls: number;
  duplicateUrlEntries: number;
  invalidLastmodValues: number;
  fragmentUrls: number;
  invalidUrls: number;
  missingLocs: number;
}

export interface PolicyReport {
  summary: PolicySummary;
  hosts?: Array<{ name: string; count: number }>;
  schemes?: Array<{ name: string; count: number }>;
  comparison?: { removedCount: number };
}

export interface DisallowedHostFinding {
  code: 'DISALLOWED_HOST';
  host: string;
  count: number;
}

export interface DisallowedSchemeFinding {
  code: 'DISALLOWED_SCHEME';
  scheme: string;
  count: number;
}

export interface MinimumFinding {
  code: 'MIN_UNIQUE_URLS' | 'MIN_UNIQUE_IMAGES';
  actual: number;
  minimum: number;
}

export interface MaximumFinding {
  code:
    | 'MAX_DUPLICATE_URLS'
    | 'MAX_DUPLICATE_URL_ENTRIES'
    | 'MAX_INVALID_LASTMOD_VALUES'
    | 'MAX_FRAGMENT_URLS'
    | 'MAX_INVALID_URLS'
    | 'MAX_MISSING_LOCS'
    | 'MAX_REMOVED_URLS';
  actual: number;
  maximum: number;
}

export type PolicyFinding =
  | DisallowedHostFinding
  | DisallowedSchemeFinding
  | MinimumFinding
  | MaximumFinding;

export interface PolicyEvaluation {
  schemaVersion: 1;
  passed: boolean;
  findings: PolicyFinding[];
}

export interface LoadPolicyOptions {
  maxPolicyBytes?: number;
}

export interface LoadedPolicy {
  path: string;
  policy: Policy;
}

export declare const POLICY_SCHEMA_VERSION: 1;

export declare function parsePolicyObject(value: unknown): Policy;
export declare function loadPolicyFile(
  input: string,
  options?: LoadPolicyOptions,
): Promise<LoadedPolicy>;
export declare function evaluatePolicy(
  report: PolicyReport,
  policyInput: unknown,
): PolicyEvaluation;
export declare function policyFindingMessage(finding: PolicyFinding): string;
