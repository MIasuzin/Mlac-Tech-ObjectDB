'use strict';

const {
  fileMagic,
  recordMagic,
  version,
  previousVersion,
  headerSize,
  bucketCount,
  bucketSize,
  dataOffset,
  recordHeaderSize,
  MaxPathLength,
  maxJsonSize,
  headerStateOffset,
  metadataOffsets,
  metadataSize,
  headerStates,
  recordTypes,
  transactionPath
} = require('./constants.js');

const {crc32} = require('./checksum.js');
const {codes, createError} = require('./errors.js');

function createHeader() {
  const buffer = Buffer.alloc(headerSize);
  fileMagic.copy(buffer, 0);
  buffer.writeUInt32LE(version, 4);
  buffer.writeUInt32LE(bucketCount, 8);
  buffer.writeUInt8(headerStates.CLEAN, headerStateOffset);
  buffer.writeBigUInt64LE(BigInt(dataOffset), 16);
  const emptyIndexChecksum = crc32([Buffer.alloc(bucketCount * bucketSize)]);
  createMetadataSlot(1n, headerStates.CLEAN, dataOffset, emptyIndexChecksum).copy(buffer, metadataOffsets[0]);
  createMetadataSlot(0n, headerStates.CLEAN, dataOffset, emptyIndexChecksum).copy(buffer, metadataOffsets[1]);
  return buffer;
}

function validateHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length !== headerSize) {
    throw createError(codes.invalidHeader, 'Invalid database header');
  }

  if (!buffer.subarray(0, 4).equals(fileMagic)) {
    throw createError(codes.invalidMagic, 'Invalid database signature');
  }

  const storedVersion = buffer.readUInt32LE(4);
  if (storedVersion !== version && storedVersion !== previousVersion) {
    throw createError(codes.unsupportedVersion, `Database version ${storedVersion} is not supported`);
  }

  const storedBucketCount = buffer.readUInt32LE(8);
  if (storedBucketCount !== bucketCount) {
    throw createError(codes.invalidIndex, 'Invalid index bucket count');
  }

  const storedDataOffset = readSafeUInt64(buffer, 16, codes.invalidHeader);
  if (storedDataOffset !== dataOffset) {
    throw createError(codes.invalidHeader, 'Invalid data section offset');
  }

  const slots = metadataOffsets.map((offset, slot) => readMetadataSlot(buffer.subarray(offset, offset + metadataSize), slot));
  const active = slots.filter(Boolean).sort((left, right) => left.generation > right.generation ? -1 : left.generation < right.generation ? 1 : left.slot - right.slot)[0];
  if (active) return {...active, version: storedVersion, legacy: false, metadataDamaged: false, legacyDirty: buffer.readUInt8(headerStateOffset) === headerStates.DIRTY};

  const legacy = metadataOffsets.every(offset => buffer.subarray(offset, offset + metadataSize).every(value => value === 0));
  if (!legacy) return {state: headerStates.DIRTY, generation: 0n, slot: 1, version: storedVersion, legacy: false, metadataDamaged: true};

  const state = buffer.readUInt8(headerStateOffset);
  if (state !== headerStates.CLEAN && state !== headerStates.DIRTY) {
    throw createError(codes.invalidHeaderState, `Invalid header state: ${state}`);
  }

  return {state, generation: 0n, slot: 1, version: storedVersion, legacy: true, metadataDamaged: false};
}

function createMetadataSlot(generation, state, fileSize, indexChecksum) {
  const buffer = Buffer.alloc(metadataSize);
  buffer.writeBigUInt64LE(generation, 0);
  buffer.writeUInt8(state, 8);
  buffer.writeBigUInt64LE(BigInt(fileSize), 16);
  buffer.writeUInt32LE(indexChecksum, 24);
  buffer.writeUInt32LE(crc32([buffer.subarray(0, 28)]), 28);
  return buffer;
}

function readMetadataSlot(buffer, slot) {
  if (buffer.readUInt32LE(28) !== crc32([buffer.subarray(0, 28)])) return null;
  const generation = buffer.readBigUInt64LE(0);
  const state = buffer.readUInt8(8);
  if (state !== headerStates.CLEAN && state !== headerStates.DIRTY) return null;
  if (!buffer.subarray(9, 16).every(value => value === 0)) return null;

  const fileSize = buffer.readBigUInt64LE(16);
  if (fileSize < BigInt(dataOffset) || fileSize > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return {generation, state, fileSize: Number(fileSize), indexChecksum: buffer.readUInt32LE(24), slot};
}

function createRecord(type, filePath, data, previousOffset) {
  if (!Object.values(recordTypes).includes(type)) {
    throw createError(codes.invalidRecordType, 'Invalid record type');
  }

  if (typeof filePath !== 'string') {
    throw createError(codes.invalidRecordPath, 'Record path must be a string');
  }

  const pathBuffer = Buffer.from(filePath, 'utf8');
  if (pathBuffer.length === 0 || pathBuffer.length > MaxPathLength) {
    throw createError(codes.invalidRecordPath, 'Invalid record path length');
  }

  const dataBuffer = data === undefined ? Buffer.alloc(0) : data;
  if (!Buffer.isBuffer(dataBuffer)) {
    throw createError(codes.invalidRecordData, 'Record data must be a buffer');
  }

  if (dataBuffer.length > maxJsonSize) {
    throw createError(codes.jsonTooLarge, `JSON exceeds the ${maxJsonSize}-byte limit`);
  }

  const expectedDataLength = type === recordTypes.TX_BEGIN ? 8 : type === recordTypes.TX_COMMIT ? 4 : 0;
  if (type !== recordTypes.WRITE && dataBuffer.length !== expectedDataLength) {
    throw createError(codes.invalidRecordData, 'Non-write record contains data');
  }

  if ((type === recordTypes.TX_BEGIN || type === recordTypes.TX_COMMIT) && filePath !== transactionPath) {
    throw createError(codes.invalidRecordPath, 'Invalid transaction marker path');
  }

  if (!Number.isSafeInteger(previousOffset) || previousOffset < 0) {
    throw createError(codes.invalidRecordOffset, 'Invalid previous record offset');
  }

  const checksumMeta = createChecksumMeta(type, pathBuffer.length, dataBuffer.length, previousOffset);
  const checksum = crc32([checksumMeta, pathBuffer, dataBuffer]);
  const header = Buffer.alloc(recordHeaderSize);
  
  recordMagic.copy(header, 0);
  header.writeUInt8(type, 4);
  header.writeUInt32LE(pathBuffer.length, 8);
  header.writeUInt32LE(dataBuffer.length, 12);
  header.writeBigUInt64LE(BigInt(previousOffset), 16);
  header.writeUInt32LE(checksum, 24);
  return Buffer.concat([header, pathBuffer, dataBuffer]);
}

function parseRecordHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length !== recordHeaderSize) {
    throw createError(codes.corruptedRecord, 'Invalid record header');
  }

  if (!buffer.subarray(0, 4).equals(recordMagic)) {
    throw createError(codes.corruptedRecord, 'Invalid record signature');
  }

  if (!buffer.subarray(5, 8).every(value => value === 0) || !buffer.subarray(28, 32).every(value => value === 0)) {
    throw createError(codes.corruptedRecord, 'Invalid reserved record header bytes');
  }

  const type = buffer.readUInt8(4);
  if (!Object.values(recordTypes).includes(type)) {
    throw createError(codes.corruptedRecord, 'Invalid record type');
  }

  const pathLength = buffer.readUInt32LE(8);
  const dataLength = buffer.readUInt32LE(12);
  const previousOffset = readSafeUInt64(buffer, 16, codes.corruptedRecord);
  const checksum = buffer.readUInt32LE(24);
  if (pathLength === 0 || pathLength > MaxPathLength) {
    throw createError(codes.corruptedRecord, 'Invalid record path length');
  }

  if (dataLength > maxJsonSize) {
    throw createError(codes.corruptedRecord, 'Invalid record data length');
  }

  const expectedDataLength = type === recordTypes.TX_BEGIN ? 8 : type === recordTypes.TX_COMMIT ? 4 : 0;
  if (type !== recordTypes.WRITE && dataLength !== expectedDataLength) {
    throw createError(codes.corruptedRecord, 'Non-write record contains data');
  }

  return {
    type,
    pathLength,
    dataLength,
    previousOffset,
    checksum
  };
}

function verifyRecordChecksum(record) {
  const checksumMeta = createChecksumMeta(record.type, record.pathLength, record.dataLength, record.previousOffset);
  const checksum = crc32([checksumMeta, record.pathBuffer, record.dataBuffer]);
  if (checksum !== record.checksum) {
    throw createError(codes.corruptedRecord, `Record checksum mismatch: ${record.path}`);
  }
}

function createChecksumMeta(type, pathLength, dataLength, previousOffset) {
  const buffer = Buffer.alloc(17);
  buffer.writeUInt8(type, 0);
  buffer.writeUInt32LE(pathLength, 1);
  buffer.writeUInt32LE(dataLength, 5);
  buffer.writeBigUInt64LE(BigInt(previousOffset), 9);
  return buffer;
}

function readSafeUInt64(buffer, offset, errorCode) {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw createError(errorCode, 'Offset exceeds the supported range');
  }
  return Number(value);
}

module.exports = {
  createHeader,
  validateHeader,
  createMetadataSlot,
  readMetadataSlot,
  createRecord,
  parseRecordHeader,
  verifyRecordChecksum
};
