'use strict';

const fs = require('fs');
const path = require('path');

const {codes, createError} = require('./errors.js');
const {readExactly, writeExactly} = require('./io.js');
const {recoverDatabaseFile} = require('./recovery.js');
const {readStoredRecord} = require('./record.js');
const {WriterLock} = require('./lock.js');
const {hashPath} = require('./checksum.js');
const {createHeader, validateHeader, createRecord} = require('./format.js');
const {checkPath, checkJsonPath, getParentPath, getDirectoryChain} = require('./paths.js');

const {
  headerSize,
  bucketCount, 
  bucketSize, 
  indexOffset, 
  dataOffset, 
  maxJsonSize, 
  headerStateOffset, 
  headerStates, 
  recordTypes
} = require('./constants.js');

const openedDatabases = new Map();

function open(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw createError(codes.invalidFilePath, 'File path must be a non-empty string');
  }

  const resolvedPath = resolveDatabasePath(filePath.trim());
  const pathKey = getPathKey(resolvedPath);
  if (openedDatabases.has(pathKey)) {
    throw createError(codes.alreadyOpen, `Database is already open in this process: ${resolvedPath}`);
  }

  let fd;
  let writerLock;

  try {
    writerLock = new WriterLock(resolvedPath);
    fd = openOrCreateFile(resolvedPath);

    const header = validateDatabaseFile(fd);
    if (header.state === headerStates.DIRTY) {
      recoverDatabaseFile(fd)
      writeDatabaseState(fd, headerStates.CLEAN);
      fs.fsyncSync(fd);
    }

    const database = new Database(resolvedPath, fd, () => {
      writerLock.release();
      openedDatabases.delete(pathKey);
    });

    openedDatabases.set(pathKey, database);
    return createPublicDatabase(database);
  }

  catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      }

      catch {}
    }

    if (writerLock) {
      try {
        writerLock.release();
      }

      catch {}
    }

    throw error;
  }
}

function resolveDatabasePath(filePath) {
  const resolvedPath = path.resolve(filePath);
  if (path.extname(resolvedPath).toLowerCase() !== '.mtdb') {
    throw createError(codes.invalidFileExtension, 'Database file must use the .mtdb extension');
  }

  const parentPath = fs.realpathSync.native(path.dirname(resolvedPath));
  const canonicalPath = path.join(parentPath, path.basename(resolvedPath));

  let stats;

  try {
    stats = fs.lstatSync(canonicalPath);
  }

  catch (error) {
    if (error.code === 'ENOENT') return canonicalPath;
    throw error;
  }

  if (stats.isSymbolicLink()) {
    throw createError(codes.symlinkUnsupported, `Symbolic links are not supported: ${canonicalPath}`);
  }

  return canonicalPath;
}

function openExistingDatabaseFile(filePath) {
  const flags = fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0);
  let fd;

  try {
    fd = fs.openSync(filePath, flags);
  }

  catch (error) {
    if (error.code === 'ELOOP') {
      const wrappedError = createError(codes.symlinkUnsupported, `Symbolic links are not supported: ${filePath}`);
      wrappedError.cause = error;
      throw wrappedError;
    }

    throw error;
  }

  try {
    const openedStats = fs.fstatSync(fd, {bigint: true});
    let pathStats;

    try {
      pathStats = fs.lstatSync(filePath, {bigint: true});
    }

    catch (error) {
      if (error.code !== 'ENOENT') throw error;

      const wrappedError = createError(codes.fileChanged, `Database file changed during opening: ${filePath}`);
      wrappedError.cause = error;
      throw wrappedError;
    }

    if (pathStats.isSymbolicLink()) {
      throw createError(codes.symlinkUnsupported, `Symbolic links are not supported: ${filePath}`);
    }

    if (openedStats.dev !== pathStats.dev || openedStats.ino !== pathStats.ino) {
      throw createError(codes.fileChanged, `Database file changed during opening: ${filePath}`);
    }

    return fd;
  }

  catch (error) {
    try {
      fs.closeSync(fd);
    }

    catch (closeError) {
      if (!error.cause) error.cause = closeError;
    }

    throw error;
  }
}

function openOrCreateFile(filePath) {
  const tempPath = `${filePath}.create.tmp`;

  fs.rmSync(tempPath, {force: true});
  try {
    return openExistingDatabaseFile(filePath);
  }

  catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  let fd;

  try {
    fd = fs.openSync(tempPath, 'wx+');

    initializeDatabaseFile(fd);

    fs.closeSync(fd);
    fd = undefined;

    fs.renameSync(tempPath, filePath);

    return openExistingDatabaseFile(filePath);
  }

  catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      }

      catch {}
    }

    try {
      fs.rmSync(tempPath, {force: true});
    }

    catch {}

    throw error;
  }
}

function writeDatabaseLayout(fd, indexBuffer) {
  const header = createHeader();

  writeExactly(fd, header, 0);
  writeExactly(fd, indexBuffer, indexOffset);
}

function initializeDatabaseFile(fd) {
  const indexBuffer = Buffer.alloc(bucketCount * bucketSize);

  writeDatabaseLayout(fd, indexBuffer);
  fs.fsyncSync(fd);
}

function writeRecordPair(fd, endOffset, type, filePath, dataBuffer, previousOffset) {
  const recordBuffer = createRecord(type, filePath, dataBuffer, previousOffset);
  const recordOffset = endOffset;
  writeExactly(fd, recordBuffer, recordOffset);

  const commitBuffer = createRecord(recordTypes.COMMIT, filePath, Buffer.alloc(0), recordOffset);
  const commitOffset = recordOffset + recordBuffer.length;
  writeExactly(fd, commitBuffer, commitOffset);

  return {
    recordOffset,
    endOffset: commitOffset + commitBuffer.length
  };
}

function validateDatabaseFile(fd) {
  const stats = fs.fstatSync(fd);
  if (!stats.isFile()) {
    throw createError(codes.pathNotFile, 'Database path is not a regular file');
  }

  if (stats.nlink > 1) {
    throw createError(codes.hardlinkUnsupported, 'Hard links are not supported');
  }

  if (stats.size < dataOffset) {
    throw createError(codes.corruptedFile, 'Database file is smaller than the minimum size');
  }

  const header = Buffer.alloc(headerSize);
  readExactly(fd, header, 0);

  return validateHeader(header);
}

function writeDatabaseState(fd, state) {
  writeExactly(fd, Buffer.from([state]), headerStateOffset);
}

function getPathKey(filePath) {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

function createPublicDatabase(database) {
  return {
    mkdir(directoryPath) {
      return database.mkdir(directoryPath);
    },

    list(directoryPath) {
      return database.list(directoryPath);
    },

    read(filePath) {
      return database.read(filePath);
    },

    write(filePath, value) {
      return database.write(filePath, value);
    },

    delete(filePath) {
      return database.delete(filePath);
    },

    compact() {
      return database.compact();
    },

    close() {
      return database.close();
    }
  };
}

class Database {
  constructor(filePath, fd, onClose) {
    this.filePath = filePath;
    this.fd = fd;
    this.onClose = onClose;
    this.closed = false;
    this.dirty = false;
    this.recoveryRequired = false;
    this.operationInProgress = false;
    this.endOffset = fs.fstatSync(fd).size;

    if (this.endOffset < dataOffset) {
      throw createError(codes.corruptedFile, 'Database file is smaller than the minimum size');
    }
  }

  mkdir(directoryPath) {
    const normalizedPath = checkPath(directoryPath);
    return this.runOperation(() => this.mkdirInternal(normalizedPath));
  }

  list(directoryPath) {
    const normalizedPath = checkPath(directoryPath, true);
    return this.runOperation(() => this.listInternal(normalizedPath), {retryAfterRecovery: true});
  }

  read(filePath) {
    const normalizedPath = checkJsonPath(filePath);
    return this.runOperation(() => this.readInternal(normalizedPath), {retryAfterRecovery: true});
  }

  write(filePath, value) {
    const normalizedPath = checkJsonPath(filePath);
    let serialized;
    try {
      serialized = JSON.stringify(value);
    }

    catch (error) {
      const wrappedError = createError(codes.invalidJson, `Failed to serialize JSON at ${normalizedPath}: ${error.message}`);
      wrappedError.cause = error;
      throw wrappedError;
    }

    if (serialized === undefined) {
      throw createError(codes.invalidJson, `Value at ${normalizedPath} cannot be serialized as JSON`);
    }

    const dataBuffer = Buffer.from(serialized, 'utf8');
    if (dataBuffer.length > maxJsonSize) {
      throw createError(codes.jsonTooLarge, `JSON at ${normalizedPath} exceeds the ${maxJsonSize}-byte limit`);
    }

    return this.runOperation(() => this.writeInternal(normalizedPath, dataBuffer));
  }

  delete(filePath) {
    const normalizedPath = checkJsonPath(filePath);
    return this.runOperation(() => this.deleteInternal(normalizedPath));
  }

  compact() {
    return this.runOperation(() => this.compactInternal());
  }

  close() {
    if (this.closed) return false;

    if (this.operationInProgress) {
      throw createError(codes.reentrantOperation, 'Nested database operations are not allowed');
    }

    this.operationInProgress = true;
    try {
      if (this.fd !== null) {
        if (this.dirty && !this.recoveryRequired) {
          writeDatabaseState(this.fd, headerStates.CLEAN);
          fs.fsyncSync(this.fd);
          this.dirty = false;
        }

        fs.closeSync(this.fd);
        this.fd = null;
      }

      this.finalizeClose();
      return true;
    }

    finally {
      this.operationInProgress = false;
    }
  }

  finalizeClose() {
    if (this.onClose) {
      this.onClose(this.filePath);
      this.onClose = null;
    }
    this.closed = true;
  }

  finalizeCloseAfterError(error) {
    try {
      this.finalizeClose();
    }

    catch (closeError) {
      closeError.cause = error;
      throw closeError;
    }

    throw error;
  }

  runOperation(operation, options = {}) {
    const {retryAfterRecovery = false} = options;
    this.assertOpen();
    if (this.operationInProgress) {
      throw createError(codes.reentrantOperation, 'Nested database operations are not allowed');
    }

    if (this.recoveryRequired) {
      throw createError(codes.recoveryRequired, 'Database must be closed and reopened after a write failure');
    }

    this.operationInProgress = true;

    try {
      return operation();
    }

    catch (error) {
      if (error?.code !== codes.corruptedIndex) throw error;

      const recovery = recoverDatabaseFile(this.fd);
      this.endOffset = recovery.endOffset;
      this.recoveryRequired = false;

      if (retryAfterRecovery) return operation();

      const wrappedError = createError(codes.operationOutcomeUnknown, 'Database index was recovered, but the modifying operation was not repeated');
      wrappedError.cause = error;
      throw wrappedError;
    }

    finally {
      this.operationInProgress = false;
    }
  }

  mkdirInternal(directoryPath) {
    const directories = getDirectoryChain(directoryPath);
    let created = false;
    for (const currentPath of directories) {
      const current = this.findRecord(currentPath);
      if (current && current.type === recordTypes.DIRECTORY) continue;

      if (current && current.type === recordTypes.WRITE) {
        throw createError(codes.pathIsFile, `Path ${currentPath} is already used by a JSON file`);
      }

      this.appendMutation(recordTypes.DIRECTORY, currentPath, Buffer.alloc(0));
      created = true;
    }

    return created;
  }

  listInternal(directoryPath) {
    if (directoryPath) {
      const directory = this.findRecord(directoryPath);
      if (!directory || directory.type === recordTypes.DELETE) {
        throw createError(codes.directoryNotFound, `Directory ${directoryPath} does not exist`);
      }

      if (directory.type !== recordTypes.DIRECTORY) {
        throw createError(codes.pathIsFile, `Path ${directoryPath} is not a directory`);
      }
    }

    const prefix = directoryPath ? `${directoryPath}/` : '';
    const result = [];
    for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
      const seenPaths = new Set();

      for (const {record} of this.walkBucket(bucketIndex)) {
        if (seenPaths.has(record.path)) continue;
        seenPaths.add(record.path);

        if (record.type === recordTypes.WRITE && record.path.startsWith(prefix)) {
          const relativePath = record.path.slice(prefix.length);
          if (relativePath && !relativePath.includes('/')) {
            result.push(record.path);
          }
        }
      }
    }

    result.sort();
    return result;
  }

  readInternal(filePath) {
    const record = this.findRecord(filePath);
    if (!record || record.type === recordTypes.DELETE) {
      return undefined;
    }

    if (record.type === recordTypes.DIRECTORY) {
      throw createError(codes.pathIsDirectory, `Path ${filePath} is a directory`);
    }

    try {
      return JSON.parse(record.dataBuffer.toString('utf8'));
    }

    catch (error) {
      const wrappedError = createError(codes.corruptedJson, `Stored JSON at ${filePath} is corrupted: ${error.message}`);
      wrappedError.cause = error;
      throw wrappedError;
    }
  }

  writeInternal(filePath, dataBuffer) {
    const parentPath = getParentPath(filePath);
    if (parentPath) {
      const parent = this.findRecord(parentPath);
      if (!parent || parent.type === recordTypes.DELETE) {
        throw createError(codes.directoryNotFound, `Directory ${parentPath} does not exist`);
      }

      if (parent.type !== recordTypes.DIRECTORY) {
        throw createError(codes.pathIsFile, `Parent path ${parentPath} is not a directory`);
      }
    }

    const current = this.findRecord(filePath);
    if (current && current.type === recordTypes.DIRECTORY) {
      throw createError(codes.pathIsDirectory, `Path ${filePath} is already used by a directory`);
    }

    this.appendMutation(recordTypes.WRITE, filePath, dataBuffer);
    return true;
  }

  deleteInternal(filePath) {
    const current = this.findRecord(filePath);
    if (!current || current.type === recordTypes.DELETE) {
      return false;
    }

    if (current.type === recordTypes.DIRECTORY) {
      throw createError(codes.pathIsDirectory, `Path ${filePath} is a directory`);
    }

    this.appendMutation(recordTypes.DELETE, filePath, Buffer.alloc(0));
    return true;
  }

  compactInternal() {
    const beforeSize = fs.fstatSync(this.fd).size;
    const tempPath = `${this.filePath}.compact.tmp`;
    const compactIndex = Buffer.alloc(bucketCount * bucketSize);

    let tempFd = null;
    let compactEndOffset = dataOffset;
    let scannedRecords = 0;
    let writtenRecords = 0;
    let files = 0;
    let directories = 0;
    let deleted = 0;
    let historical = 0;

    fs.rmSync(tempPath, {force: true});
    try {
      tempFd = fs.openSync(tempPath, 'wx+');
      writeDatabaseLayout(tempFd, compactIndex);

      for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
        const seenPaths = new Set();
        const currentOffsets = [];

        for (const {offset, record} of this.walkBucket(bucketIndex)) {
          scannedRecords += 1;

          if (!seenPaths.has(record.path)) {
            seenPaths.add(record.path);

            if (record.type === recordTypes.DELETE) {
              deleted += 1;
            }

            else if (record.type === recordTypes.WRITE || record.type === recordTypes.DIRECTORY) {
              currentOffsets.push(offset);
            }

            else {
              throw createError(codes.corruptedRecord, `Invalid record type: ${record.type}`);
            }
          }

          else {
            historical += 1;
          }
        }

        for (let i = currentOffsets.length - 1; i >= 0; i -= 1) {
          const record = this.readRecord(currentOffsets[i]);
          this.assertRecordBucket(record, bucketIndex);

          const result = this.writeCompactRecord(tempFd, compactIndex, compactEndOffset, bucketIndex, record);
          compactEndOffset = result.endOffset;
          writtenRecords += 1;

          if (record.type === recordTypes.WRITE) files += 1;
          else directories += 1;
        }
      }

      writeExactly(tempFd, compactIndex, indexOffset);
      fs.ftruncateSync(tempFd, compactEndOffset);
      fs.fsyncSync(tempFd);

      const validation = recoverDatabaseFile(tempFd);
      if (validation.indexChanged || validation.truncatedBytes !== 0) {
        throw createError(codes.compactValidationFailed, 'Compact file validation found an inconsistency');
      }

      fs.fsyncSync(tempFd);
      fs.closeSync(tempFd);
      tempFd = null;

      const afterSize = fs.statSync(tempPath).size;
      this.replaceWithCompactFile(tempPath);

      return {
        beforeSize,
        afterSize,
        reclaimedBytes: beforeSize - afterSize,
        scannedRecords,
        writtenRecords,
        files,
        directories,
        deleted,
        historical
      };
    }

    catch (error) {
      if (tempFd !== null) {
        try {
          fs.closeSync(tempFd);
        }

        catch {}
      }

      try {
        fs.rmSync(tempPath, {force: true});
      }

      catch {}
      throw error;
    }
  }

  writeCompactRecord(fd, indexBuffer, endOffset, bucketIndex, record) {
    const indexPosition = bucketIndex * bucketSize;
    const previousOffsetBigInt = indexBuffer.readBigUInt64LE(indexPosition);
    if (previousOffsetBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw createError(codes.compactFailed, 'Compact index offset exceeds the supported range');
    }

    const previousOffset = Number(previousOffsetBigInt);
    const dataBuffer = record.type === recordTypes.WRITE ? record.dataBuffer : Buffer.alloc(0);
    const result = writeRecordPair(fd, endOffset, record.type, record.path, dataBuffer, previousOffset);

    indexBuffer.writeBigUInt64LE(BigInt(result.recordOffset), indexPosition);
    return result;
  }

  replaceWithCompactFile(tempPath) {
    const previousDirty = this.dirty;

    fs.fsyncSync(this.fd);
    fs.closeSync(this.fd);
    this.fd = null;

    try {
      fs.renameSync(tempPath, this.filePath);
    }

    catch (error) {
      try {
        this.fd = openExistingDatabaseFile(this.filePath);
        this.endOffset = fs.fstatSync(this.fd).size;
        this.dirty = previousDirty;
      }

      catch (reopenError) {
        reopenError.cause = error;
        this.finalizeCloseAfterError(reopenError);
      }

      throw error;
    }

    try {
      this.fd = openExistingDatabaseFile(this.filePath);
      this.endOffset = fs.fstatSync(this.fd).size;
      this.dirty = false;
      this.recoveryRequired = false;
    }

    catch (error) {
      this.finalizeCloseAfterError(error);
    }
  }

  appendMutation(type, filePath, dataBuffer) {
    this.ensureDirty();
    try {
      const bucketIndex = this.getBucketIndex(filePath);
      const previousOffset = this.readBucket(bucketIndex);

      const result = writeRecordPair(this.fd, this.endOffset, type, filePath, dataBuffer, previousOffset);

      this.endOffset = result.endOffset;
      fs.fsyncSync(this.fd);

      this.writeBucket(bucketIndex, result.recordOffset);
      fs.fsyncSync(this.fd);

      return result.recordOffset;
    }

    catch (error) {
      this.recoveryRequired = true;
      throw error;
    }
  }

  ensureDirty() {
    if (this.dirty) return;

    try {
      writeDatabaseState(this.fd, headerStates.DIRTY);
      fs.fsyncSync(this.fd);
      this.dirty = true;
    }

    catch (error) {
      this.recoveryRequired = true;
      throw error;
    }
  }

  *walkBucket(bucketIndex) {
    let offset = this.readBucket(bucketIndex);
    let chainDepth = 0;

    while (offset !== 0) {
      chainDepth += 1;
      if (chainDepth > 5000000) {
        throw createError(codes.corruptedIndex, `Bucket chain ${bucketIndex} exceeds the supported depth`);
      }

      const record = this.readRecord(offset);
      if (record.type === recordTypes.COMMIT) {
        throw createError(codes.corruptedIndex, `Bucket ${bucketIndex} points to a COMMIT record at offset ${offset}`);
      }

      this.assertRecordBucket(record, bucketIndex);
      if (record.previousOffset !== 0 && record.previousOffset >= offset) {
        throw createError(codes.corruptedIndex, `Invalid bucket chain: ${bucketIndex}`);
      }

      yield {offset, record};
      offset = record.previousOffset;
    }
  }

  findRecord(filePath) {
    const bucketIndex = this.getBucketIndex(filePath);

    for (const {record} of this.walkBucket(bucketIndex)) {
      if (record.path === filePath) return record;
    }

    return null;
  }

  assertRecordBucket(record, bucketIndex) {
    const actualBucketIndex = this.getBucketIndex(record.path);
    if (actualBucketIndex !== bucketIndex) {
      throw createError(codes.corruptedIndex, `Record ${record.path} is stored in invalid bucket ${bucketIndex}`);
    }
  }

  readRecord(offset) {
    return readStoredRecord(this.fd, offset, this.endOffset, {invalidOffsetCode: codes.corruptedIndex});
  }

  getBucketIndex(filePath) {
    return hashPath(filePath) % bucketCount;
  }

  readBucket(bucketIndex) {
    const buffer = Buffer.alloc(bucketSize);
    const position = indexOffset + bucketIndex * bucketSize;
    readExactly(this.fd, buffer, position);

    const value = buffer.readBigUInt64LE(0);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw createError(codes.corruptedIndex, 'Index offset exceeds the supported range');
    }

    return Number(value);
  }

  writeBucket(bucketIndex, offset) {
    const buffer = Buffer.alloc(bucketSize);
    buffer.writeBigUInt64LE(BigInt(offset), 0);
    const position = indexOffset + bucketIndex * bucketSize;
    writeExactly(this.fd, buffer, position);
  }

  assertOpen() {
    if (this.closed || this.fd === null) {
      throw createError(codes.closed, 'Database is closed');
    }
  }
}

module.exports = {open};