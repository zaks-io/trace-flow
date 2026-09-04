import {
  ArchiveContractError,
  GENESIS_CHAIN_HASH,
  type ArchiveObservation,
  type ArchiveAppendProof,
  type CompletedScanCheckpoint,
  decodeBase64Bytes,
  digestBytes,
  payloadBytes,
} from './archive-contract';
import { hashFramed } from './archive-chain';

const PREFIX_CHAIN_DOMAIN = new TextEncoder().encode('trace-flow/archive/source-prefix-chain/v1');

function isAsciiWhitespace(byte: number): boolean {
  return byte === 0x09 || byte === 0x0c || byte === 0x0d || byte === 0x20;
}

function prefixRecordLines(prefix: Uint8Array): Uint8Array[] {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  const lines: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index <= prefix.length; index++) {
    if (index !== prefix.length && prefix[index] !== 0x0a) continue;
    const line = prefix.slice(start, index);
    start = index + 1;
    if (line.length === 0 || line.every(isAsciiWhitespace)) continue;
    try {
      JSON.parse(decoder.decode(line));
    } catch {
      throw new ArchiveContractError('checkpoint_prefix_unverifiable');
    }
    lines.push(line);
  }
  return lines;
}

function assertPrefixMatchesObservations(
  prefix: Uint8Array,
  observations: ArchiveObservation[],
): void {
  const lines = prefixRecordLines(prefix);
  if (lines.length !== observations.length) {
    throw new ArchiveContractError('checkpoint_prefix_unverifiable');
  }
  observations.forEach((observation, index) => {
    const payload = payloadBytes(observation);
    const line = lines[index];
    if (
      line?.length !== payload.length ||
      line?.some((byte, offset) => byte !== payload[offset]) === true
    ) {
      throw new ArchiveContractError('checkpoint_prefix_unverifiable');
    }
  });
}

async function prefixDigest(prefix: Uint8Array): Promise<string> {
  return `sha256:${Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', prefix)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

export async function assertStoredPrefixHash(
  completePrefixBase64: string | undefined,
  previousCheckpoint: CompletedScanCheckpoint,
): Promise<void> {
  if (completePrefixBase64 === undefined) {
    throw new ArchiveContractError('missing_historical_prefix_proof');
  }
  const prefix = decodeBase64Bytes(completePrefixBase64);
  if (prefix.byteLength < previousCheckpoint.last_complete_byte_offset) {
    throw new ArchiveContractError('historical_prefix_changed');
  }
  const storedPrefix = prefix.slice(0, previousCheckpoint.last_complete_byte_offset);
  if ((await prefixDigest(storedPrefix)) !== previousCheckpoint.complete_prefix_sha256) {
    throw new ArchiveContractError('historical_prefix_changed');
  }
}

function numberBytes(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ArchiveContractError('invalid_checkpoint_offset');
  }
  const bytes = new Uint8Array(8);
  let remaining = BigInt(value);
  for (let index = bytes.length - 1; index >= 0; index--) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

export async function prefixChainHash(
  previous: string | undefined,
  appendedBytes: Uint8Array,
): Promise<string> {
  return hashFramed(PREFIX_CHAIN_DOMAIN, [
    digestBytes(previous ?? GENESIS_CHAIN_HASH),
    numberBytes(appendedBytes.byteLength),
    appendedBytes,
  ]);
}

function assertAppendProof(value: unknown): asserts value is ArchiveAppendProof {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ArchiveContractError('checkpoint_prefix_unverifiable');
  }
  const proof = value as Record<string, unknown>;
  if (typeof proof.prior_prefix_chain_sha256 !== 'string') {
    throw new ArchiveContractError('checkpoint_prefix_unverifiable');
  }
  if (typeof proof.appended_prefix_base64 !== 'string') {
    throw new ArchiveContractError('checkpoint_prefix_unverifiable');
  }
}

export async function assertPrefixHash(
  observations: ArchiveObservation[],
  checkpoint: CompletedScanCheckpoint,
  completePrefixBase64: string | undefined,
  priorCheckpoint: CompletedScanCheckpoint | undefined,
): Promise<void> {
  if (completePrefixBase64 === undefined) {
    throw new ArchiveContractError('missing_historical_prefix_proof');
  }
  const prefix = decodeBase64Bytes(completePrefixBase64);
  if (prefix.byteLength !== checkpoint.last_complete_byte_offset) {
    throw new ArchiveContractError('checkpoint_prefix_unverifiable');
  }
  if ((await prefixDigest(prefix)) !== checkpoint.complete_prefix_sha256) {
    throw new ArchiveContractError('checkpoint_prefix_unverifiable');
  }
  if ((await prefixChainHash(undefined, prefix)) !== checkpoint.prefix_chain_sha256) {
    throw new ArchiveContractError('checkpoint_prefix_unverifiable');
  }
  assertPrefixMatchesObservations(prefix, observations);
  if (priorCheckpoint) {
    if (priorCheckpoint.last_complete_byte_offset > prefix.byteLength) {
      throw new ArchiveContractError('checkpoint_prefix_unverifiable');
    }
    const priorPrefix = prefix.slice(0, priorCheckpoint.last_complete_byte_offset);
    if ((await prefixDigest(priorPrefix)) !== priorCheckpoint.complete_prefix_sha256) {
      throw new ArchiveContractError('historical_prefix_changed');
    }
  }
}

export async function assertDeltaPrefixHash(
  observations: ArchiveObservation[],
  checkpoint: CompletedScanCheckpoint,
  priorCheckpoint: CompletedScanCheckpoint,
  appendProof: ArchiveAppendProof | undefined,
): Promise<void> {
  assertAppendProof(appendProof);
  if (appendProof.prior_prefix_chain_sha256 !== priorCheckpoint.prefix_chain_sha256) {
    throw new ArchiveContractError('historical_prefix_changed');
  }
  const appendedPrefix = decodeBase64Bytes(appendProof.appended_prefix_base64);
  const expectedDeltaBytes =
    checkpoint.last_complete_byte_offset - priorCheckpoint.last_complete_byte_offset;
  if (checkpoint.last_complete_byte_offset < priorCheckpoint.last_complete_byte_offset) {
    throw new ArchiveContractError('checkpoint_prefix_unverifiable');
  }
  if (appendedPrefix.byteLength !== expectedDeltaBytes) {
    throw new ArchiveContractError('checkpoint_prefix_unverifiable');
  }
  const expectedPrefixChain =
    appendedPrefix.byteLength === 0
      ? priorCheckpoint.prefix_chain_sha256
      : await prefixChainHash(priorCheckpoint.prefix_chain_sha256, appendedPrefix);
  if (expectedPrefixChain !== checkpoint.prefix_chain_sha256) {
    throw new ArchiveContractError('checkpoint_prefix_unverifiable');
  }
  assertPrefixMatchesObservations(appendedPrefix, observations);
}
