import {
  type ArchiveScope,
  type ArchiveUploadRequest,
  type ChunkByteRange,
  type LedgerElement,
} from './archive-contract';
import type { SourceFingerprint } from './archive-validation';

export interface ScanState {
  checkpoint: ArchiveUploadRequest['checkpoint'];
}

export interface LedgerSnapshot {
  scope?: ArchiveScope;
  keyVersion?: number;
  elementCount: number;
  recordCount: number;
  chainHead: string;
  generation: number;
  manifestKey?: string;
  manifestHeadPageKey?: string;
}

export interface LedgerCommit {
  scope: ArchiveScope;
  keyVersion: number;
  elementCount: number;
  recordCount: number;
  chainHead: string;
  generation: number;
  manifestKey: string;
  manifestHeadPageKey: string;
  newElements: LedgerElement[];
  ranges: Record<string, ChunkByteRange>;
  scan: {
    partId: string;
    checkpoint: ArchiveUploadRequest['checkpoint'];
    fingerprints: SourceFingerprint[];
    replace: boolean;
  };
}

export interface CommitEnvelope {
  scope: ArchiveScope;
  upload: ArchiveUploadRequest;
  keyVersion: number;
  wrappedKey: string;
}

export interface ArchiveAcknowledgement {
  status: 'acknowledged';
  duplicate: boolean;
  source: ArchiveScope['source'];
  source_session_id: string;
  contribution_id: string;
  appended_records: number;
  appended_checkpoint: boolean;
  record_count: number;
  generation: number;
  chain_head: string;
  manifest_key: string;
  chunk_keys: string[];
}
