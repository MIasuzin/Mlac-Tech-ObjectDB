'use strict';

const {codes, createError} = require('./errors.js');
const {dataOffset, recordHeaderSize, recordTypes, transactionPath} = require('./constants.js');
const {readExactly} = require('./io.js');
const {parseRecordHeader, verifyRecordChecksum} = require('./format.js');
const {checkPath, checkJsonPath} = require('./paths.js');

function readStoredRecord(fd, offset, fileSize, options = {}) {
  const {allowIncomplete = false, invalidOffsetCode = codes.corruptedRecord} = options;
  if (!Number.isSafeInteger(offset) || offset < dataOffset) {
    throw createError(invalidOffsetCode, `Invalid record offset: ${offset}`);
  }

  if (offset + recordHeaderSize > fileSize) {
    if (allowIncomplete) return null;
    throw createError(invalidOffsetCode, `Record header at offset ${offset} extends beyond the end of file`);
  }

  const headerBuffer = Buffer.alloc(recordHeaderSize);
  readExactly(fd, headerBuffer, offset);

  const header = parseRecordHeader(headerBuffer);
  const recordSize = recordHeaderSize + header.pathLength + header.dataLength;
  if (offset + recordSize > fileSize) {
    if (allowIncomplete) return null;
    throw createError(codes.corruptedRecord, `Record at offset ${offset} extends beyond the end of file`);
  }

  const bodyBuffer = Buffer.alloc(header.pathLength + header.dataLength);
  readExactly(fd, bodyBuffer, offset + recordHeaderSize);

  const pathBuffer = bodyBuffer.subarray(0, header.pathLength);
  const dataBuffer = bodyBuffer.subarray(header.pathLength);
  const recordPath = decodeRecordPath(pathBuffer);
  const record = {
    ...header,
    pathBuffer,
    dataBuffer,
    path: recordPath,
    recordSize
  };

  verifyRecordChecksum(record);
  if (record.type === recordTypes.TX_BEGIN || record.type === recordTypes.TX_COMMIT) {
    if (record.path !== transactionPath) throw createError(codes.corruptedRecord, 'Invalid transaction marker path');
  }

  else if (record.type !== recordTypes.COMMIT) {
    validateStoredRecordPath(record.type, record.path);
  }

  return record;
}

function decodeRecordPath(pathBuffer) {
  const recordPath = pathBuffer.toString('utf8');
  if (!Buffer.from(recordPath, 'utf8').equals(pathBuffer)) {
    throw createError(codes.corruptedRecord, 'Stored record path is not valid UTF-8');
  }
  return recordPath;
}

function validateStoredRecordPath(type, storedPath) {
  let checkStoredPath;
  if (type === recordTypes.DIRECTORY) {
    checkStoredPath = checkPath;
  }

  else if (type === recordTypes.WRITE || type === recordTypes.DELETE) {
    checkStoredPath = checkJsonPath;
  }

  else {
    throw createError(codes.corruptedRecord, `Invalid record type: ${type}`);
  }

  let checkedPath;

  try {
    checkedPath = checkStoredPath(storedPath);
  }

  catch (error) {
    if (error?.code !== codes.invalidPath && error?.code !== codes.pathTooLong && error?.code !== codes.jsonExtensionRequired) {
      throw error;
    }

    const wrappedError = createError(codes.corruptedRecord, `Stored path is invalid: ${storedPath}`);
    wrappedError.cause = error;
    throw wrappedError;
  }

  if (checkedPath !== storedPath) {
    throw createError(codes.corruptedRecord, `Stored path is not normalized: ${storedPath}`);
  }
}

module.exports = {
  readStoredRecord
};