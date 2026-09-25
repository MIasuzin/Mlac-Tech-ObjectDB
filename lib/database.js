'use strict';

const fs = require('fs');
const path = require('path');
const {randomUUID} = require('crypto');
const {Worker} = require('worker_threads');

const {codes, createError} = require('./errors.js');
const {readExactly, writeExactly} = require('./io.js');
const {recoverDatabaseFile, inspectDatabaseFile, verifyDatabaseFile} = require('./recovery.js');
const {readStoredRecord} = require('./record.js');
const {WriterLock} = require('./lock.js');
const {hashPath, crc32} = require('./checksum.js');
const {createHeader, validateHeader, createMetadataSlot, createRecord} = require('./format.js');
const {checkPath, checkJsonPath, getParentPath, getDirectoryChain} = require('./paths.js');

const {
  headerSize,
  bucketCount, 
  bucketSize, 
  indexOffset, 
  dataOffset, 
  maxJsonSize,
  maxTransactionBytes,
  maxTransactionRecords,
  maxJournalTransactionRecords,
  transactionPath,
  version,
  headerStateOffset,
  metadataOffsets,
  headerStates, 
  recordTypes
} = require('./constants.js');

const openedDatabases = new Map();

function open(filePath, internal = false) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw createError(codes.invalidFilePath, 'File path must be a non-empty string');
  }

  const resolvedPath = resolveDatabasePath(filePath.trim());
  const pathKey = getPathKey(resolvedPath);
  if (openedDatabases.has(pathKey)) {
    throw createError(codes.databaseLocked, `Database is already open in this process: ${resolvedPath}`);
  }

  let fd;
  let writerLock;

  try {
    writerLock = new WriterLock(resolvedPath);
    cleanupStaleCompactionFiles(resolvedPath);
    fd = openOrCreateFile(resolvedPath);

    let metadata = validateDatabaseFile(fd);
    const fileSize = fs.fstatSync(fd).size;
    if (metadata.legacy || metadata.metadataDamaged || metadata.legacyDirty || metadata.state === headerStates.DIRTY || metadata.fileSize !== fileSize || metadata.indexChecksum !== readIndexChecksum(fd)) {
      const resetMetadata = metadata.legacy || metadata.metadataDamaged;
      if (metadata.state !== headerStates.DIRTY) {
        writeDatabaseState(fd, headerStates.DIRTY);
        fs.fsyncSync(fd);
        metadata = writeMetadata(fd, metadata, headerStates.DIRTY);
      }

      recoverDatabaseFile(fd);
      metadata = writeMetadata(fd, metadata, headerStates.CLEAN);
      if (resetMetadata) metadata = writeMetadata(fd, metadata, headerStates.CLEAN);
      writeDatabaseState(fd, headerStates.CLEAN);
      fs.fsyncSync(fd);
    }

    if (!internal && metadata.version !== version) {
      throw createError(codes.unsupportedVersion, 'Database v2 requires offline migration before opening');
    }

    const database = new Database(resolvedPath, fd, metadata, () => {
      openedDatabases.delete(pathKey);
      writerLock.release();
    }, !internal);

    openedDatabases.set(pathKey, database);
    if (!internal) database.scheduleCompaction(true);
    return internal ? database : createPublicDatabase(database);
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
    syncParentDirectory(filePath);

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

function serializeJson(filePath, value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  }

  catch (error) {
    const wrappedError = createError(codes.invalidJson, `Failed to serialize JSON at ${filePath}: ${error.message}`);
    wrappedError.cause = error;
    throw wrappedError;
  }

  if (serialized === undefined) {
    throw createError(codes.invalidJson, `Value at ${filePath} cannot be serialized as JSON`);
  }

  const dataBuffer = Buffer.from(serialized, 'utf8');
  if (dataBuffer.length > maxJsonSize) {
    throw createError(codes.jsonTooLarge, `JSON at ${filePath} exceeds the ${maxJsonSize}-byte limit`);
  }

  return dataBuffer;
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

function readIndexChecksum(fd) {
  const buffer = Buffer.alloc(bucketCount * bucketSize);
  readExactly(fd, buffer, indexOffset);
  return crc32([buffer]);
}

function writeMetadata(fd, current, state) {
  if (current.generation === 0xffffffffffffffffn) {
    throw createError(codes.invalidHeader, 'Metadata generation overflow');
  }

  const slot = 1 - current.slot;
  const generation = current.generation + 1n;
  const fileSize = fs.fstatSync(fd).size;
  const indexChecksum = state === headerStates.CLEAN ? readIndexChecksum(fd) : 0;
  writeExactly(fd, createMetadataSlot(generation, state, fileSize, indexChecksum), metadataOffsets[slot]);
  fs.fsyncSync(fd);
  return {
    generation,
    state, 
    fileSize, 
    indexChecksum, 
    slot, 
    version: current.version, 
    legacy: false, 
    metadataDamaged: false
  };
}

function syncParentDirectory(filePath) {
  if (process.platform === 'win32') return;
  let fd;
  try {
    fd = fs.openSync(path.dirname(filePath), 'r');
    fs.fsyncSync(fd);
  }

  catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR'].includes(error.code)) throw error;
  }

  finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function cleanupStaleCompactionFiles(filePath) {
  const directory = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.compact-`;
  for (const name of fs.readdirSync(directory)) {
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mtdb(?:\.compact\.tmp|\.lock(?:\.guard)?)?$/.test(suffix)) continue;
    try {
      fs.rmSync(path.join(directory, name), {force: true});
    }

    catch {}
  }
}

function getPathKey(filePath) {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

function createPublicDatabase(database) {
  return {
    mkdir(directoryPath) {
      return database.mkdir(directoryPath);
    },

    list(directoryPath, options) {
      return database.list(directoryPath, options);
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

    rmdir(directoryPath, options) {
      return database.rmdir(directoryPath, options);
    },

    has(filePath) {
      return database.has(filePath);
    },

    verify() {
      return database.verify();
    },

    stats() {
      return database.stats();
    },

    transaction(handler) {
      return database.transaction(handler);
    },

    close() {
      return database.close();
    }
  };
}

function loadLatestPaths(fd) {
  const inspection = inspectDatabaseFile(fd);
  if (inspection.truncatedBytes !== 0) {
    throw createError(codes.corruptedLog, 'Uncommitted journal tail in an open database');
  }

  if (inspection.indexChanged) {
    throw createError(codes.corruptedIndex, 'Database index differs from the committed journal');
  }

  const latestPaths = new Map();
  for (const [filePath, entry] of inspection.livePaths) {
    if (entry.type !== recordTypes.DELETE) {
      latestPaths.set(filePath, {offset: entry.offset, type: entry.type});
    }
  }

  return latestPaths;
}

class Database {
  constructor(filePath, fd, metadata, onClose, autoCompact) {
    this.filePath = filePath;
    this.fd = fd;
    this.onClose = onClose;
    this.metadata = metadata;
    this.closed = false;
    this.dirty = false;
    this.recoveryRequired = false;
    this.operationInProgress = false;
    this.transactionActive = false;
    this.autoCompact = autoCompact;
    this.compactWorker = null;
    this.compactTimer = null;
    this.lastCompactCheck = 0;
    this.maintenanceError = null;
    this.endOffset = fs.fstatSync(fd).size;
    this.lastCompactOffset = this.endOffset;
    this.indexBuffer = Buffer.alloc(bucketCount * bucketSize);
    readExactly(fd, this.indexBuffer, indexOffset);

    if (this.endOffset < dataOffset) {
      throw createError(codes.corruptedFile, 'Database file is smaller than the minimum size');
    }

    this.latestPaths = loadLatestPaths(fd);
  }

  mkdir(directoryPath) {
    const normalizedPath = checkPath(directoryPath);
    return this.runOperation(() => this.mkdirInternal(normalizedPath));
  }

  list(directoryPath, options) {
    const normalizedPath = checkPath(directoryPath, true);
    let recursive = false;
    if (options !== undefined) {
      const prototype = options !== null && typeof options === 'object' ? Object.getPrototypeOf(options) : undefined;
      if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(options).some(key => key !== 'recursive')) {
        throw createError(codes.invalidListOptions, 'List options must contain only a boolean recursive property');
      }

      const descriptor = Object.getOwnPropertyDescriptor(options, 'recursive');
      if (descriptor && typeof descriptor.value !== 'boolean') {
        throw createError(codes.invalidListOptions, 'List options must contain only a boolean recursive property');
      }
      recursive = descriptor?.value === true;
    }

    return this.runOperation(() => this.listInternal(normalizedPath, recursive), {retryAfterRecovery: true});
  }

  read(filePath) {
    const normalizedPath = checkJsonPath(filePath);
    return this.runOperation(() => this.readInternal(normalizedPath), {retryAfterRecovery: true});
  }

  write(filePath, value) {
    const normalizedPath = checkJsonPath(filePath);
    const dataBuffer = serializeJson(normalizedPath, value);
    return this.runOperation(() => this.writeInternal(normalizedPath, dataBuffer));
  }

  delete(filePath) {
    const normalizedPath = checkJsonPath(filePath);
    return this.runOperation(() => this.deleteInternal(normalizedPath));
  }

  rmdir(directoryPath, options) {
    const normalizedPath = checkPath(directoryPath);
    let recursive = false;
    if (options !== undefined) {
      const prototype = options !== null && typeof options === 'object' ? Object.getPrototypeOf(options) : undefined;
      if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(options).some(key => key !== 'recursive')) {
        throw createError(codes.invalidRmdirOptions, 'Rmdir options must contain only a boolean recursive property');
      }
      const descriptor = Object.getOwnPropertyDescriptor(options, 'recursive');
      if (descriptor && typeof descriptor.value !== 'boolean') {
        throw createError(codes.invalidRmdirOptions, 'Rmdir options must contain only a boolean recursive property');
      }
      recursive = descriptor?.value === true;
    }
    return this.runOperation(() => this.rmdirInternal(normalizedPath, recursive));
  }

  has(filePath) {
    const normalizedPath = checkPath(filePath, true);
    return this.runOperation(() => {
      if (!normalizedPath) return true;
      const record = this.findRecord(normalizedPath);
      if (!record || record.type === recordTypes.DELETE) return false;
      if (record.type !== recordTypes.WRITE && record.type !== recordTypes.DIRECTORY) {
        throw createError(codes.corruptedIndex, `Invalid record type at ${normalizedPath}`);
      }
      return true;
    }, {retryAfterRecovery: true});
  }

  verify() {
    return this.runOperation(() => verifyDatabaseFile(this.fd), {recoverCorruptedIndex: false});
  }

  stats() {
    return this.runOperation(() => {
      const {valid, metadataSlots, ...statistics} = verifyDatabaseFile(this.fd);
      return {...statistics, maintenanceError: this.maintenanceError};
    }, {recoverCorruptedIndex: false});
  }

  transaction(handler) {
    if (this.transactionActive) throw createError(codes.nestedTransaction, 'Nested transactions are not supported');
    if (typeof handler !== 'function') throw createError(codes.invalidTransaction, 'Transaction handler must be a function');
    return this.runOperation(() => {
      this.transactionActive = true;
      try {
        return this.transactionInternal(handler);
      }

      finally {
        this.transactionActive = false;
      }
    }, {recoverCorruptedIndex: false});
  }

  close() {
    if (this.closed) return false;

    if (this.operationInProgress) {
      throw createError(codes.reentrantOperation, 'Nested database operations are not allowed');
    }

    this.operationInProgress = true;
    try {
      this.stopCompaction();
      if (this.fd !== null) {
        if (this.dirty && !this.recoveryRequired) {
          if (readIndexChecksum(this.fd) !== crc32([this.indexBuffer])) {
            throw createError(codes.corruptedIndex, 'Index changed while the database was open');
          }
          this.metadata = writeMetadata(this.fd, this.metadata, headerStates.CLEAN);
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

    catch (error) {
      this.recoveryRequired = true;
      if (this.fd !== null) {
        try {
          fs.closeSync(this.fd);
        }

        catch (closeError) {
          if (!error.cause) error.cause = closeError;
        }
        this.fd = null;
      }
      this.finalizeCloseAfterError(error);
    }

    finally {
      this.operationInProgress = false;
    }
  }

  finalizeClose() {
    if (this.onClose) {
      const onClose = this.onClose;
      this.onClose = null;
      this.closed = true;
      onClose(this.filePath);
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
    const {retryAfterRecovery = false, recoverCorruptedIndex = true} = options;
    this.assertOpen();
    if (this.operationInProgress) {
      throw createError(codes.reentrantOperation, 'Nested database operations are not allowed');
    }

    if (this.recoveryRequired) {
      throw createError(codes.recoveryRequired, 'Database must be closed and reopened after a write failure');
    }

    this.operationInProgress = true;

    try {
      const result = operation();
      this.scheduleCompaction();
      return result;
    }

    catch (error) {
      if (error?.code !== codes.corruptedIndex || !recoverCorruptedIndex) throw error;

      let recovery;
      try {
        if (!this.dirty) {
          writeDatabaseState(this.fd, headerStates.DIRTY);
          fs.fsyncSync(this.fd);
          this.metadata = writeMetadata(this.fd, this.metadata, headerStates.DIRTY);
          this.dirty = true;
        }
        recovery = recoverDatabaseFile(this.fd);
        this.endOffset = recovery.endOffset;
        readExactly(this.fd, this.indexBuffer, indexOffset);
        this.latestPaths = loadLatestPaths(this.fd);
      }

      catch (recoveryError) {
        this.recoveryRequired = true;
        throw recoveryError;
      }
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

   listInternal(directoryPath, recursive) {
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
          if (relativePath && (recursive || !relativePath.includes('/'))) {
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
    this.assertWritableFile(filePath);
    this.appendMutation(recordTypes.WRITE, filePath, dataBuffer);
    return true;
  }

  assertWritableFile(filePath) {
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

  rmdirInternal(directoryPath, recursive) {
    const current = this.findRecord(directoryPath);
    if (!current || current.type === recordTypes.DELETE) return false;
    if (current.type !== recordTypes.DIRECTORY) {
      throw createError(codes.pathIsFile, `Path ${directoryPath} is not a directory`);
    }

    const prefix = `${directoryPath}/`;
    const entries = [];
    for (const [filePath, entry] of this.latestPaths) {
      if (!filePath.startsWith(prefix)) continue;
      if (entry.type !== recordTypes.WRITE && entry.type !== recordTypes.DIRECTORY) {
        throw createError(codes.corruptedIndex, `Invalid record type in directory ${directoryPath}`);
      }
      if (!recursive) throw createError(codes.directoryNotEmpty, `Directory ${directoryPath} is not empty`);

      entries.push({path: filePath, type: entry.type});
      if (entries.length >= maxJournalTransactionRecords) {
        throw createError(codes.transactionTooLarge, 'Recursive removal exceeds the journal record limit');
      }
    }

    if (entries.length === 0) {
      this.appendMutation(recordTypes.DELETE, directoryPath, Buffer.alloc(0));
      return true;
    }

    entries.sort((first, second) => {
      if (first.type !== second.type) return first.type === recordTypes.WRITE ? -1 : 1;
      const depth = second.path.split('/').length - first.path.split('/').length;
      return depth || first.path.localeCompare(second.path);
    });
    entries.push({path: directoryPath, type: recordTypes.DIRECTORY});
    const changes = new Map();
    let mutationBytes = 0;
    for (const entry of entries) {
      mutationBytes += 32 + Buffer.byteLength(entry.path, 'utf8');
      if (mutationBytes > maxTransactionBytes) {
        throw createError(codes.transactionTooLarge, 'Recursive removal exceeds the transaction size limit');
      }
      changes.set(entry.path, {type: recordTypes.DELETE, dataBuffer: Buffer.alloc(0)});
    }
    this.appendTransaction(changes);
    return true;
  }

  transactionInternal(handler) {
    const changes = new Map();
    let stagedBytes = 0;
    let active = true;
    const assertActive = () => {
      if (!active) throw createError(codes.transactionClosed, 'Transaction is no longer active');
    };
    const stage = (filePath, type, dataBuffer) => {
      const old = changes.get(filePath);
      const bytes = 32 + Buffer.byteLength(filePath, 'utf8') + dataBuffer.length;
      const nextBytes = stagedBytes - (old?.bytes ?? 0) + bytes;
      if (nextBytes > maxTransactionBytes || (!old && changes.size >= maxTransactionRecords)) {
        throw createError(codes.transactionTooLarge, 'Transaction exceeds the size or record limit');
      }
      changes.set(filePath, {type, dataBuffer, bytes});
      stagedBytes = nextBytes;
    };

    const tx = Object.freeze({
      read: filePath => {
        assertActive();
        const normalizedPath = checkJsonPath(filePath);
        const change = changes.get(normalizedPath);
        if (change) return change.type === recordTypes.DELETE ? undefined : JSON.parse(change.dataBuffer.toString('utf8'));
        return this.readInternal(normalizedPath);
      },
      write: (filePath, value) => {
        assertActive();
        const normalizedPath = checkJsonPath(filePath);
        const dataBuffer = serializeJson(normalizedPath, value);
        this.assertWritableFile(normalizedPath);
        stage(normalizedPath, recordTypes.WRITE, dataBuffer);
        return true;
      },
      delete: filePath => {
        assertActive();
        const normalizedPath = checkJsonPath(filePath);
        const change = changes.get(normalizedPath);
        if (change?.type === recordTypes.DELETE) return false;

        const original = this.findRecord(normalizedPath);
        if (original?.type === recordTypes.DIRECTORY) {
          throw createError(codes.pathIsDirectory, `Path ${normalizedPath} is a directory`);
        }

        if (!change && (!original || original.type === recordTypes.DELETE)) return false;
        if (change && (!original || original.type === recordTypes.DELETE)) {
          stagedBytes -= change.bytes;
          changes.delete(normalizedPath);
        }

        else stage(normalizedPath, recordTypes.DELETE, Buffer.alloc(0));
        return true;
      }
    });

    let result;
    try {
      result = handler(tx);
      if (result && typeof result.then === 'function') {
        if (result instanceof Promise) result.catch(() => {});
        throw createError(codes.asyncTransactionNotSupported, 'Async transactions are not supported');
      }
    }

    finally {
      active = false;
    }

    if (changes.size === 0) return result;
    if (this.metadata.version !== version) {
      throw createError(codes.unsupportedVersion, 'Migrate the v2 database before using transactions');
    }
    this.appendTransaction(changes);
    return result;
  }

  appendTransaction(changes) {
    const startOffset = this.endOffset;
    const beginData = Buffer.alloc(8);
    beginData.writeUInt32LE(changes.size, 0);
    let beginBuffer = createRecord(recordTypes.TX_BEGIN, transactionPath, beginData, 0);
    let nextOffset = startOffset + beginBuffer.length;
    const buffers = [];
    const bucketHeads = new Map();
    const mutationOffsets = new Map();

    for (const [filePath, change] of changes) {
      const bucketIndex = this.getBucketIndex(filePath);
      const previousOffset = bucketHeads.get(bucketIndex) ?? this.readBucket(bucketIndex);
      const buffer = createRecord(change.type, filePath, change.dataBuffer, previousOffset);
      buffers.push(buffer);
      mutationOffsets.set(filePath, nextOffset);
      bucketHeads.set(bucketIndex, nextOffset);
      nextOffset += buffer.length;
    }

    const mutationBytes = nextOffset - startOffset - beginBuffer.length;
    beginData.writeUInt32LE(mutationBytes, 4);
    beginBuffer = createRecord(recordTypes.TX_BEGIN, transactionPath, beginData, 0);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32LE(crc32([beginBuffer, ...buffers]), 0);
    const commitBuffer = createRecord(recordTypes.TX_COMMIT, transactionPath, checksum, startOffset);

    this.ensureDirty();
    try {
      writeExactly(this.fd, beginBuffer, startOffset);
      let offset = startOffset + beginBuffer.length;
      for (const buffer of buffers) {
        writeExactly(this.fd, buffer, offset);
        offset += buffer.length;
      }
      writeExactly(this.fd, commitBuffer, offset);
      this.endOffset = offset + commitBuffer.length;
      fs.fsyncSync(this.fd);

      for (const [bucketIndex, head] of bucketHeads) this.writeBucket(bucketIndex, head);
      fs.fsyncSync(this.fd);

      for (const [filePath, change] of changes) {
        if (change.type === recordTypes.DELETE) this.latestPaths.delete(filePath);
        else this.latestPaths.set(filePath, {offset: mutationOffsets.get(filePath), type: change.type});
      }
    }

    catch (error) {
      this.recoveryRequired = true;
      throw error;
    }
  }

  scheduleCompaction(startup = false) {
    if (!this.autoCompact || this.closed || this.recoveryRequired || this.metadata.version !== version || this.compactWorker || this.compactTimer) return;
    if (this.endOffset - this.lastCompactOffset < 8 * 1024 * 1024 && (!startup || this.endOffset < dataOffset + 8 * 1024 * 1024)) return;
    if (Date.now() - this.lastCompactCheck < 5 * 60 * 1000) return;

    this.compactTimer = setImmediate(() => {
      this.compactTimer = null;
      if (this.closed || this.recoveryRequired || this.compactWorker || this.operationInProgress) return;
      this.lastCompactCheck = Date.now();
      this.lastCompactOffset = this.endOffset;
      try {
        this.startCompaction();
      }

      catch (error) {
        this.maintenanceError = {code: error.code || 'worker_start_failed', message: error.message};
      }
    });
    this.compactTimer.unref();
  }

  startCompaction() {
    const tempPath = `${this.filePath}.compact-${randomUUID()}.mtdb`;
    const worker = new Worker(path.join(__dirname, 'maintenance-worker.js'), {
      workerData: {sourcePath: this.filePath, tempPath, endOffset: this.endOffset, indexBuffer: Buffer.from(this.indexBuffer)}
    });
    const attempt = {worker, tempPath, catchups: 0};
    this.compactWorker = attempt;
    worker.on('message', message => this.handleCompactionMessage(attempt, message));
    worker.on('error', error => {
      if (this.compactWorker === attempt && !this.closed) this.maintenanceError = {code: error.code || 'worker_error', message: error.message};
    });
    worker.on('exit', code => {
      if (this.compactWorker === attempt) {
        this.compactWorker = null;
        if (code !== 0 && code !== 1 && !this.closed && !this.maintenanceError) {
          this.maintenanceError = {code: 'worker_exit', message: `Maintenance worker exited with code ${code}`};
        }
      }
      try {
        fs.rmSync(tempPath, {force: true});
      }

      catch {}
      try {
        fs.rmSync(`${tempPath}.compact.tmp`, {force: true});
      }

      catch {}
    });
    worker.unref();
  }

  handleCompactionMessage(attempt, message) {
    if (this.compactWorker !== attempt) return;
    if (message.type === 'error') {
      this.maintenanceError = {code: message.code || 'maintenance_failed', message: message.message};
      if (message.sourceCorrupted) this.recoveryRequired = true;
      attempt.worker.terminate().catch(() => {});
      return;
    }
    if (message.type === 'skipped' || this.closed || this.recoveryRequired) {
      attempt.worker.terminate().catch(() => {});
      return;
    }
    if (message.type !== 'ready') return;

    if (message.endOffset !== this.endOffset || !Buffer.from(message.indexBuffer).equals(this.indexBuffer)) {
      if (attempt.catchups >= 3) {
        attempt.worker.terminate().catch(() => {});
        return;
      }
      attempt.catchups += 1;
      try {
        attempt.worker.postMessage({type: 'catchup', endOffset: this.endOffset, indexBuffer: Buffer.from(this.indexBuffer)});
      }

      catch (error) {
        this.maintenanceError = {code: error.code || 'worker_message_failed', message: error.message};
        attempt.worker.terminate().catch(() => {});
      }
      return;
    }

    try {
      this.runOperation(() => this.replaceWithCompactFile(attempt.tempPath), {recoverCorruptedIndex: false});
      this.maintenanceError = null;
      this.lastCompactOffset = this.endOffset;
    }

    catch (error) {
      this.maintenanceError = {code: error.code || 'compact_failed', message: error.message};
      this.recoveryRequired = true;
    }
    attempt.worker.terminate().catch(() => {});
  }

  stopCompaction() {
    if (this.compactTimer) {
      clearImmediate(this.compactTimer);
      this.compactTimer = null;
    }
    if (this.compactWorker) this.compactWorker.worker.terminate().catch(() => {});
  }

  compactInternal() {
    const inspection = inspectDatabaseFile(this.fd);
    if (inspection.truncatedBytes > 0) {
      throw createError(codes.corruptedLog, 'Uncommitted tail found in the open database');
    }
    if (inspection.indexChanged) {
      throw createError(codes.corruptedIndex, 'Database index differs from committed journal');
    }

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

      writeMetadata(tempFd, {generation: 1n, slot: 0}, headerStates.CLEAN);
      verifyDatabaseFile(tempFd);

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
    try {
      fs.fsyncSync(this.fd);
    }

    catch (error) {
      this.recoveryRequired = true;
      throw error;
    }
    try {
      fs.closeSync(this.fd);
    }

    catch (error) {
      this.recoveryRequired = true;
      throw error;
    }
    this.fd = null;

    try {
      fs.renameSync(tempPath, this.filePath);
      syncParentDirectory(this.filePath);
    }

    catch (error) {
      try {
        this.fd = openExistingDatabaseFile(this.filePath);
        this.endOffset = fs.fstatSync(this.fd).size;
        readExactly(this.fd, this.indexBuffer, indexOffset);
        this.dirty = previousDirty;
        this.recoveryRequired = true;
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
      readExactly(this.fd, this.indexBuffer, indexOffset);
      this.metadata = validateDatabaseFile(this.fd);
      this.latestPaths = loadLatestPaths(this.fd);
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

      if (type === recordTypes.DELETE) this.latestPaths.delete(filePath);
      else this.latestPaths.set(filePath, {offset: result.recordOffset, type});
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
      this.metadata = writeMetadata(this.fd, this.metadata, headerStates.DIRTY);
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
    const entry = this.latestPaths.get(filePath);
    if (!entry) return null;

    const record = this.readRecord(entry.offset);
    if (record.path !== filePath || record.type !== entry.type) {
      throw createError(codes.corruptedIndex, `Cached record does not match ${filePath}`);
    }

    return record;
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
    const value = this.indexBuffer.readBigUInt64LE(bucketIndex * bucketSize);
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
    buffer.copy(this.indexBuffer, bucketIndex * bucketSize);
  }

  assertOpen() {
    if (this.closed || this.fd === null) {
      throw createError(codes.closed, 'Database is closed');
    }
  }
}

function migrateVersion2(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw createError(codes.invalidFilePath, 'File path must be a non-empty string');
  const resolved = resolveDatabasePath(filePath.trim());
  fs.lstatSync(resolved);
  const database = open(resolved, true);
  try {
    if (database.metadata.version === version) {
      database.verify();
      return false;
    }
    database.runOperation(() => database.compactInternal(), {recoverCorruptedIndex: false});
    database.verify();
    return true;
  }

  finally {
    database.close();
  }
}

module.exports = {open, migrateVersion2};