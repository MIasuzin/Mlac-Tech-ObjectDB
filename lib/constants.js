'use strict';

const fileMagic = Buffer.from('MTDB');
const recordMagic = Buffer.from('MTR1');

const version = 3;
const previousVersion = 2;
const headerSize = 4096;

const headerStateOffset = 12;
const metadataOffsets = Object.freeze([32, 64]);
const metadataSize = 32;
const headerStates = Object.freeze({CLEAN: 0, DIRTY: 1});

const bucketCount = 65536;
const bucketSize = 8;
const indexOffset = headerSize;
const dataOffset = indexOffset + bucketCount * bucketSize;
const recordHeaderSize = 32;
const MaxPathLength = 1024;
const maxJsonSize = 100 * 1024 * 1024;
const maxTransactionBytes = 128 * 1024 * 1024;
const maxTransactionRecords = 1000;
const maxJournalTransactionRecords = 100_001;
const transactionPath = '@tx';

const recordTypes = Object.freeze({
  DIRECTORY: 1,
  WRITE: 2,
  DELETE: 3,
  COMMIT: 4,
  TX_BEGIN: 5,
  TX_COMMIT: 6
});

module.exports = {
  fileMagic,
  recordMagic,
  version,
  previousVersion,
  headerSize,
  bucketCount,
  bucketSize,
  indexOffset,
  dataOffset,
  recordHeaderSize,
  MaxPathLength,
  maxJsonSize,
  maxTransactionBytes,
  maxTransactionRecords,
  maxJournalTransactionRecords,
  transactionPath,
  headerStateOffset,
  metadataOffsets,
  metadataSize,
  headerStates,
  recordTypes
};