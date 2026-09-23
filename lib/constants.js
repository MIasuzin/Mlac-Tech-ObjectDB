'use strict';

const fileMagic = Buffer.from('MTDB');
const recordMagic = Buffer.from('MTR1');

const version = 2;
const headerSize = 4096;

const headerStateOffset = 12;

const headerStates = Object.freeze({
  CLEAN: 0,
  DIRTY: 1
});

const bucketCount = 65536;
const bucketSize = 8;
const indexOffset = headerSize;
const dataOffset = indexOffset + bucketCount * bucketSize;
const recordHeaderSize = 32;
const MaxPathLength = 1024;
const maxJsonSize = 100 * 1024 * 1024;

const recordTypes = Object.freeze({
  DIRECTORY: 1,
  WRITE: 2,
  DELETE: 3,
  COMMIT: 4
});

module.exports = {
  fileMagic,
  recordMagic,
  version,
  headerSize,
  bucketCount,
  bucketSize,
  indexOffset,
  dataOffset,
  recordHeaderSize,
  MaxPathLength,
  maxJsonSize,
  headerStateOffset,
  headerStates,
  recordTypes
};