'use strict';

const fs = require('fs');

const {codes, createError} = require('./errors.js');
const {bucketCount, bucketSize, indexOffset, dataOffset, recordTypes} = require('./constants.js');
const {hashPath} = require('./checksum.js');
const {readStoredRecord} = require('./record.js');
const {readExactly, writeExactly} = require('./io.js');

function recoverDatabaseFile(fd) {
  const stats = fs.fstatSync(fd);
  if (stats.size < dataOffset) {
    throw createError(codes.corruptedFile, 'Database file is smaller than the minimum size');
  }

  const indexSize = bucketCount * bucketSize;
  const rebuiltIndex = Buffer.alloc(indexSize);
  let fileSize = stats.size;
  let offset = dataOffset;
  let lastCommittedEnd = dataOffset;
  let pendingRecord = null;

  while (offset < fileSize) {
    const record = readStoredRecord(fd, offset, fileSize, {allowIncomplete: true});
    if (!record) break;

    if (record.type === recordTypes.COMMIT) {
      if (!pendingRecord) {
        throw createError(codes.corruptedLog, `COMMIT at offset ${offset} has no pending record`);
      }

      if (record.path !== pendingRecord.path) {
        throw createError(codes.corruptedLog, `COMMIT at offset ${offset} references a different path`);
      }

      if (record.previousOffset !== pendingRecord.offset) {
        throw createError(codes.corruptedLog, `COMMIT at offset ${offset} references an invalid record offset`);
      }

      writeBucketToBuffer(rebuiltIndex, pendingRecord.bucketIndex, pendingRecord.offset);
      pendingRecord = null;
      lastCommittedEnd = offset + record.recordSize;
    }

    else {
      if (pendingRecord) {
        throw createError(codes.corruptedLog, `Record ${record.path} appears before the previous record was committed`);
      }

      const bucketIndex = hashPath(record.path) % bucketCount;
      const expectedPreviousOffset = readBucketFromBuffer(rebuiltIndex, bucketIndex);
      if (record.previousOffset !== expectedPreviousOffset) {
        throw createError(codes.corruptedLog, `Invalid record chain for ${record.path}`);
      }

      pendingRecord = {
        offset,
        path: record.path,
        bucketIndex
      };
    }

    offset += record.recordSize;
  }

  let truncatedBytes = 0;
  if (offset < fileSize || pendingRecord) {
    truncatedBytes = fileSize - lastCommittedEnd;
    if (truncatedBytes > 0) {
      fs.ftruncateSync(fd, lastCommittedEnd);
      fileSize = lastCommittedEnd;
    }
  }

  const currentIndex = Buffer.alloc(indexSize);
  readExactly(fd, currentIndex, indexOffset);

  const indexChanged = !currentIndex.equals(rebuiltIndex);
  if (indexChanged) writeExactly(fd, rebuiltIndex, indexOffset);

  const recovered = truncatedBytes > 0 || indexChanged;
  if (recovered) fs.fsyncSync(fd);

  return {
    recovered,
    indexChanged,
    truncatedBytes,
    endOffset: fileSize
  };
}

function readBucketFromBuffer(indexBuffer, bucketIndex) {
  const position = bucketIndex * bucketSize;
  const value = indexBuffer.readBigUInt64LE(position);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw createError(codes.corruptedIndex, 'Index offset exceeds the supported range');
  }
  return Number(value);
}

function writeBucketToBuffer(indexBuffer, bucketIndex, offset) {
  const position = bucketIndex * bucketSize;
  indexBuffer.writeBigUInt64LE(BigInt(offset), position);
}

module.exports = {
  recoverDatabaseFile
};
