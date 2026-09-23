'use strict';

const {
  fileMagic,
  recordMagic,
  version,
  headerSize,
  bucketCount,
  dataOffset,
  recordHeaderSize,
  MaxPathLength,
  maxJsonSize,
  headerStateOffset,
  headerStates,
  recordTypes
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
  if (storedVersion !== version) {
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

  const state = buffer.readUInt8(headerStateOffset);
  if (state !== headerStates.CLEAN && state !== headerStates.DIRTY) {
    throw createError(codes.invalidHeaderState, `Invalid header state: ${state}`);
  }

  return {state};
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

  if (type !== recordTypes.WRITE && dataBuffer.length !== 0) {
    throw createError(codes.invalidRecordData, 'Non-write record contains data');
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

  if (type !== recordTypes.WRITE && dataLength !== 0) {
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
  createRecord,
  parseRecordHeader,
  verifyRecordChecksum
};
