'use strict';

const fs = require('fs');

const {codes, createError} = require('./errors.js');
const {headerSize, headerStateOffset, metadataOffsets, metadataSize, headerStates, bucketCount, bucketSize, indexOffset, dataOffset, recordTypes, maxTransactionBytes, maxTransactionRecords, previousVersion} = require('./constants.js');
const {hashPath, crc32} = require('./checksum.js');
const {validateHeader, readMetadataSlot} = require('./format.js');
const {readStoredRecord} = require('./record.js');
const {getParentPath} = require('./paths.js');
const {readExactly, writeExactly} = require('./io.js');

function recoverDatabaseFile(fd) {
  const inspection = inspectDatabaseFile(fd);
  if (inspection.truncatedBytes > 0) fs.ftruncateSync(fd, inspection.endOffset);
  if (inspection.indexChanged) writeExactly(fd, inspection.rebuiltIndex, indexOffset);
  if (inspection.truncatedBytes > 0 || inspection.indexChanged) fs.fsyncSync(fd);
  return {
    recovered: inspection.truncatedBytes > 0 || inspection.indexChanged,
    indexChanged: inspection.indexChanged,
    truncatedBytes: inspection.truncatedBytes,
    endOffset: inspection.endOffset
  };
}

function verifyDatabaseFile(fd) {
  const fileSize = fs.fstatSync(fd).size;
  if (fileSize < dataOffset) {
    const error = createError(codes.corruptedFile, 'Database file is smaller than the minimum size');
    error.offset = fileSize;
    throw error;
  }

  const header = Buffer.alloc(headerSize);
  readExactly(fd, header, 0);
  let metadata;
  try {
    metadata = validateHeader(header);
  }

  catch (error) {
    if (error.offset === undefined) {
      const fieldOffsets = {
        [codes.invalidMagic]: 0,
        [codes.unsupportedVersion]: 4,
        [codes.invalidIndex]: 8,
        [codes.invalidHeaderState]: headerStateOffset
      };
      error.offset = fieldOffsets[error.code] ?? 16;
    }
    throw error;
  }

  if (metadata.legacy || metadata.metadataDamaged) {
    const error = createError(codes.invalidHeader, 'Database metadata has no valid slots');
    error.offset = metadataOffsets[0];
    throw error;
  }

  const metadataSlots = metadataOffsets.reduce((count, offset, slot) => count + (readMetadataSlot(header.subarray(offset, offset + metadataSize), slot) ? 1 : 0), 0);
  if (header.readUInt8(headerStateOffset) !== metadata.state) {
    throw logError('Header state differs from the active metadata slot', headerStateOffset);
  }

  const inspection = inspectDatabaseFile(fd);
  if (inspection.truncatedBytes > 0) {
    throw logError('Uncommitted journal tail', inspection.endOffset);
  }

  if (inspection.indexChanged) {
    const error = createError(codes.corruptedIndex, 'Index differs from the committed journal');
    error.offset = inspection.indexErrorOffset;
    throw error;
  }

  if (metadata.state === headerStates.CLEAN) {
    if (metadata.fileSize !== fileSize) {
      const error = createError(codes.invalidHeader, 'Committed file size differs from metadata');
      error.offset = metadataOffsets[metadata.slot] + 16;
      throw error;
    }

    if (metadata.indexChecksum !== crc32([inspection.rebuiltIndex])) {
      const error = createError(codes.corruptedIndex, 'Index checksum differs from metadata');
      error.offset = metadataOffsets[metadata.slot] + 24;
      throw error;
    }
  }

  return {valid: true, fileSize, metadataSlots, ...inspection.statistics};
}

function inspectDatabaseFile(fd, endLimit) {
  const stats = fs.fstatSync(fd);
  if (stats.size < dataOffset) {
    throw createError(codes.corruptedFile, 'Database file is smaller than the minimum size');
  }

  const indexSize = bucketCount * bucketSize;
  const rebuiltIndex = Buffer.alloc(indexSize);
  const fileSize = endLimit === undefined ? stats.size : endLimit;
  if (!Number.isSafeInteger(fileSize) || fileSize < dataOffset || fileSize > stats.size) {
    throw createError(codes.corruptedFile, 'Invalid committed snapshot size');
  }

  const storedVersion = readDatabaseVersion(fd);
  let offset = dataOffset;
  let lastCommittedEnd = dataOffset;
  let pendingRecord = null;
  const livePaths = new Map();
  const liveGroups = new Map();
  let records = 0;
  let commits = 0;

  while (offset < fileSize) {
    let record;
    try {
      record = readStoredRecord(fd, offset, fileSize, {allowIncomplete: true});
    }

    catch (error) {
      if (error.offset === undefined) error.offset = offset;
      throw error;
    }

    if (!record) break;

    if (record.type === recordTypes.TX_BEGIN) {
      if (pendingRecord) throw logError('Transaction begins before the previous record was committed', offset);
      if (storedVersion === previousVersion) throw logError('Transaction marker in a v2 database', offset);

      const transaction = inspectTransaction(fd, offset, record, fileSize, rebuiltIndex, livePaths, liveGroups);
      if (!transaction) break;
      records += transaction.records;
      commits += 1;
      offset = transaction.endOffset;
      lastCommittedEnd = offset;
      continue;
    }

    if (record.type === recordTypes.TX_COMMIT) throw logError('TX_COMMIT has no preceding transaction', offset);

    if (record.type === recordTypes.COMMIT) {
      if (!pendingRecord) {
        throw logError(`COMMIT at offset ${offset} has no pending record`, offset);
      }

      if (record.path !== pendingRecord.path) {
        throw logError(`COMMIT at offset ${offset} references a different path`, offset);
      }

      if (record.previousOffset !== pendingRecord.offset) {
        throw logError(`COMMIT at offset ${offset} references an invalid record offset`, offset);
      }

      const mutation = pendingRecord.record;
      validateMutation(mutation, pendingRecord.offset, livePaths.get(mutation.path));

      writeBucketToBuffer(rebuiltIndex, pendingRecord.bucketIndex, pendingRecord.offset);
      applyMutation(livePaths, liveGroups, mutation, pendingRecord.offset, mutation.recordSize + record.recordSize);
      records += 1;
      commits += 1;
      pendingRecord = null;
      lastCommittedEnd = offset + record.recordSize;
    }

    else {
      if (pendingRecord) {
        throw logError(`Record ${record.path} appears before the previous record was committed`, offset);
      }

      const bucketIndex = hashPath(record.path) % bucketCount;
      const expectedPreviousOffset = readBucketFromBuffer(rebuiltIndex, bucketIndex);
      if (record.previousOffset !== expectedPreviousOffset) {
        throw logError(`Invalid record chain for ${record.path}`, offset);
      }

      pendingRecord = {
        offset,
        path: record.path,
        bucketIndex,
        record
      };
    }

    offset += record.recordSize;
  }

  for (const [recordPath, entry] of livePaths) {
    if (entry.type === recordTypes.DELETE) continue;
    const parentPath = getParentPath(recordPath);
    if (parentPath && livePaths.get(parentPath)?.type !== recordTypes.DIRECTORY) {
      throw logError(`Missing parent directory for ${recordPath}`, entry.offset);
    }
  }

  const truncatedBytes = offset < fileSize || pendingRecord ? fileSize - lastCommittedEnd : 0;
  const currentIndex = Buffer.alloc(indexSize);
  readExactly(fd, currentIndex, indexOffset);

  const indexChanged = !currentIndex.equals(rebuiltIndex);
  const indexErrorOffset = indexChanged ? indexOffset + currentIndex.findIndex((value, position) => value !== rebuiltIndex[position]) : undefined;
  let files = 0;
  let directories = 0;
  let liveBytes = 0;
  for (const entry of livePaths.values()) {
    if (entry.type === recordTypes.DELETE) continue;
    if (entry.type === recordTypes.WRITE) files += 1;
    else directories += 1;
    liveBytes += entry.bytes;
  }

  for (const group of liveGroups.values()) liveBytes += group.bytes;
  const journalBytes = lastCommittedEnd - dataOffset;
  const garbageBytes = journalBytes - liveBytes;
  return {
    livePaths,
    indexChanged,
    indexErrorOffset,
    truncatedBytes,
    endOffset: fileSize - truncatedBytes,
    rebuiltIndex,
    statistics: {
      records,
      commits,
      files,
      directories,
      liveRecords: files + directories,
      garbageRecords: records - files - directories,
      liveBytes,
      garbageBytes,
      garbageRatio: garbageBytes / fileSize
    }
  };
}

function readDatabaseVersion(fd) {
  const buffer = Buffer.alloc(4);
  readExactly(fd, buffer, 4);
  return buffer.readUInt32LE(0);
}

function inspectTransaction(fd, startOffset, begin, fileSize, rebuiltIndex, livePaths, liveGroups) {
  if (begin.previousOffset !== 0) throw logError('Invalid TX_BEGIN offset', startOffset);
  const count = begin.dataBuffer.readUInt32LE(0);
  const mutationBytes = begin.dataBuffer.readUInt32LE(4);
  if (count === 0 || count > maxTransactionRecords || mutationBytes > maxTransactionBytes) {
    throw logError('Invalid transaction length or record count', startOffset);
  }

  const commitOffset = startOffset + begin.recordSize + mutationBytes;
  if (commitOffset >= fileSize) return null;

  let commit;
  try {
    commit = readStoredRecord(fd, commitOffset, fileSize, {allowIncomplete: true});
  }

  catch (error) {
    if (error.offset === undefined) error.offset = commitOffset;
    throw error;
  }

  if (!commit) return null;
  if (commit.type !== recordTypes.TX_COMMIT || commit.previousOffset !== startOffset) {
    throw logError('Invalid transaction COMMIT', commitOffset);
  }

  const pendingIndex = new Map();
  const pendingPaths = new Set();
  const mutations = [];
  let offset = startOffset + begin.recordSize;
  while (offset < commitOffset) {
    let record;
    try {
      record = readStoredRecord(fd, offset, commitOffset);
    }

    catch (error) {
      if (error.offset === undefined) error.offset = offset;
      throw error;
    }

    if (record.type !== recordTypes.WRITE && record.type !== recordTypes.DELETE && record.type !== recordTypes.DIRECTORY) {
      throw logError('Invalid transaction mutation', offset);
    }

    const bucketIndex = hashPath(record.path) % bucketCount;
    const previousOffset = pendingIndex.get(bucketIndex) ?? readBucketFromBuffer(rebuiltIndex, bucketIndex);
    if (record.previousOffset !== previousOffset) throw logError(`Invalid record chain for ${record.path}`, offset);
    if (pendingPaths.has(record.path)) throw logError(`Duplicate path in transaction: ${record.path}`, offset);

    validateMutation(record, offset, livePaths.get(record.path));
    pendingPaths.add(record.path);
    pendingIndex.set(bucketIndex, offset);
    mutations.push({record, offset});
    offset += record.recordSize;
  }

  if (offset !== commitOffset || mutations.length !== count) throw logError('Transaction length or count mismatch', commitOffset);
  const groupBuffer = Buffer.alloc(begin.recordSize + mutationBytes);
  readExactly(fd, groupBuffer, startOffset);
  if (crc32([groupBuffer]) !== commit.dataBuffer.readUInt32LE(0)) {
    throw logError('Transaction checksum mismatch', commitOffset);
  }

  liveGroups.set(startOffset, {bytes: begin.recordSize + commit.recordSize, count: 0});
  for (const mutation of mutations) {
    applyMutation(livePaths, liveGroups, mutation.record, mutation.offset, mutation.record.recordSize, startOffset);
  }
  if (liveGroups.get(startOffset)?.count === 0) liveGroups.delete(startOffset);
  for (const [bucketIndex, head] of pendingIndex) writeBucketToBuffer(rebuiltIndex, bucketIndex, head);
  return {records: count, endOffset: commitOffset + commit.recordSize};
}

function validateMutation(mutation, offset, previous) {
  if (mutation.type === recordTypes.WRITE) {
    try {
      const json = mutation.dataBuffer.toString('utf8');
      if (!Buffer.from(json, 'utf8').equals(mutation.dataBuffer)) throw new Error('Invalid UTF-8');
      JSON.parse(json);
    }

    catch (error) {
      const wrapped = createError(codes.corruptedJson, `Invalid JSON at offset ${offset}: ${error.message}`);
      wrapped.offset = offset;
      wrapped.cause = error;
      throw wrapped;
    }
  }

  if ((mutation.type === recordTypes.DIRECTORY && previous?.type === recordTypes.WRITE) ||
      (mutation.type === recordTypes.WRITE && previous?.type === recordTypes.DIRECTORY) ||
      (mutation.type === recordTypes.DELETE && previous?.type !== recordTypes.WRITE)) {
    throw logError(`Invalid mutation for ${mutation.path}`, offset);
  }
}

function applyMutation(livePaths, liveGroups, mutation, offset, bytes, groupId) {
  const old = livePaths.get(mutation.path);
  if (old?.groupId !== undefined && old.type !== recordTypes.DELETE) {
    const group = liveGroups.get(old.groupId);
    group.count -= 1;
    if (group.count === 0) liveGroups.delete(old.groupId);
  }

  if (groupId !== undefined && mutation.type !== recordTypes.DELETE) liveGroups.get(groupId).count += 1;
  livePaths.set(mutation.path, {type: mutation.type, offset, bytes, groupId});
}

function logError(message, offset) {
  const error = createError(codes.corruptedLog, message);
  error.offset = offset;
  return error;
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
  recoverDatabaseFile,
  inspectDatabaseFile,
  verifyDatabaseFile
};