import type { PolicyEvaluation } from './policy.d.ts';

export type SitemapDocumentType = 'sitemapindex' | 'urlset';

export interface NamedCount {
  name: string;
  count: number;
}

export interface AuditSummary {
  documents: number;
  sitemapReferences: number;
  urlEntries: number;
  uniqueUrls: number;
  duplicateUrls: number;
  duplicateUrlEntries: number;
  imageEntries: number;
  uniqueImages: number;
  lastmodValues: number;
  invalidLastmodValues: number;
  fragmentUrls: number;
  invalidUrls: number;
  missingLocs: number;
}

export interface DuplicateUrl {
  url: string;
  count: number;
  sources: string[];
}

export interface UrlSource {
  url: string;
  source: string;
}

export interface InvalidLastmod {
  context: 'sitemap' | 'url';
  source: string;
  url: string | null;
  value: string;
}

export interface InvalidUrl extends UrlSource {
  reason: string;
}

export interface MissingLoc {
  context: 'sitemap' | 'url';
  source: string;
}

export interface AuditedDocument {
  source: string;
  type: SitemapDocumentType;
}

export interface AuditComparison {
  source: string;
  previousUniqueUrls: number;
  addedCount: number;
  removedCount: number;
  added: string[];
  removed: string[];
}

export interface AuditPolicy extends PolicyEvaluation {
  source: string;
}

export interface AuditReport {
  schemaVersion: 1;
  source: string;
  summary: AuditSummary;
  hosts: NamedCount[];
  schemes: NamedCount[];
  duplicates: DuplicateUrl[];
  fragments: UrlSource[];
  invalidLastmods: InvalidLastmod[];
  invalidUrls: InvalidUrl[];
  missingLocs: MissingLoc[];
  documents: AuditedDocument[];
  skippedAlreadyVisited: string[];
  comparison?: AuditComparison;
  policy?: AuditPolicy;
}

export interface AuditOptions {
  compare?: string;
  fetch?: typeof globalThis.fetch;
  maxXmlBytes?: number;
  maxRedirects?: number;
}

export declare const VERSION: '0.2.2';

export declare function escapeTerminalText(value: unknown): string;
export declare function formatJsonReport(report: AuditReport): string;
export declare function isIsoLastmod(value: string): boolean;
export declare function auditSitemap(input: string, options?: AuditOptions): Promise<AuditReport>;
export declare function formatTextReport(report: AuditReport): string;
export declare function sourceToFileUrl(path: string): string;
