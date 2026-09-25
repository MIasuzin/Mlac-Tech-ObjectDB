'use strict';

const fs = require('fs');
const crypto = require('crypto');
const {codes, createError} = require('./errors.js');
const {writeExactly} = require('./io.js');

class WriterLock {
  constructor(filePath) {
    const lock = createWriterLock(filePath);
    this.path = lock.path;
    this.pid = lock.pid;
    this.token = lock.token;
  }

  release() {
    return releaseWriterLock(this);
  }
}

function createWriterLock(filePath) {
  const lockPath = `${filePath}.lock`;
  const guard = createWriterLockGuard(lockPath);

  let writerLock;
  let operationError = null;
  try {
    let current = null;
    try {
      current = readWriterLock(lockPath);
    }

    catch (error) {
      if (error.code !== codes.lockChanged) throw error;
    }

    if (current) {
      if (isProcessAlive(current.pid)) {
        throw createError(codes.databaseLocked, `Database is already open by process ${current.pid}: ${filePath}`);
      }
      releaseWriterLock({path: lockPath, pid: current.pid, token: current.token});
    }

    try {
      writerLock = createWriterLockFile(lockPath);
    }

    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      throw createError(codes.databaseLocked, `Database is already locked: ${filePath}`);
    }
  }

  catch (error) {
    operationError = error;
  }

  try {
    releaseWriterLockGuard(guard);
  }

  catch (error) {
    if (operationError) operationError.cause = error;
    else operationError = error;
  }

  if (operationError) {
    if (writerLock) {
      try {
        releaseWriterLock(writerLock);
      }

      catch (cleanupError) {
        cleanupError.cause = operationError.cause;
        operationError.cause = cleanupError;
      }
    }
    throw operationError;
  }

  return writerLock;
}

function createWriterLockGuard(lockPath) {
  const guardPath = `${lockPath}.guard`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return createWriterLockFile(guardPath);
    }

    catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    let current;
    try {
      current = readWriterLock(guardPath, 'Writer lock guard');
    }

    catch (error) {
      if (error.code === codes.lockChanged) continue;

      if (error.code === codes.corruptedLock) {
        if (removeExpiredWriterLockGuard(guardPath)) continue;
        throw createError(codes.databaseLocked, `Writer lock creation is already in progress: ${guardPath}`);
      }

      throw error;
    }

    if (isProcessAlive(current.pid)) {
      throw createError(codes.databaseLocked, `Writer lock creation is already in progress: ${guardPath}`);
    }

    try {
      releaseWriterLock({path: guardPath, pid: current.pid, token: current.token}, 'Writer lock guard');
    }

    catch (error) {
      if (error.code === codes.lockChanged || error.code === codes.lockOwnershipLost) continue;
      throw error;
    }
  }

  throw createError(codes.databaseLocked, `Writer lock creation is already in progress: ${guardPath}`);
}

function removeExpiredWriterLockGuard(guardPath) {
  let stats;
  try {
    stats = fs.statSync(guardPath);
  }

  catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }

  if (Date.now() - stats.mtimeMs < 30_000) return false;

  try {
    fs.rmSync(guardPath);
  }

  catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  return true;
}

function releaseWriterLockGuard(guard) {
  const released = releaseWriterLock(guard, 'Writer lock guard');
  if (!released) {
    throw createError(codes.lockOwnershipLost, `Writer lock guard disappeared before release: ${guard.path}`);
  }
}

function createWriterLockFile(lockPath) {
  const info = {
    pid: process.pid,
    token: crypto.randomBytes(16).toString('hex')
  };

  const data = Buffer.from(`${JSON.stringify(info)}\n`, 'utf8');
  let fd;
  let created = false;
  try {
    fd = fs.openSync(lockPath, 'wx');
    created = true;
    writeExactly(fd, data, 0);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    return {
      path: lockPath,
      pid: info.pid,
      token: info.token
    };
  }

  catch (error) {
    let cleanupError = null;
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      }

      catch (caughtError) {
        cleanupError = caughtError;
      }
    }

    if (created) {
      try {
        fs.rmSync(lockPath);
      }

      catch (caughtError) {
        if (caughtError.code !== 'ENOENT') {
          caughtError.cause = cleanupError;
          cleanupError = caughtError;
        }
      }
    }

    if (cleanupError) error.cause = cleanupError;
    throw error;
  }
}

function readWriterLock(lockPath, name = 'Writer lock') {
  let content;
  try {
    content = fs.readFileSync(lockPath, 'utf8');
  }

  catch (error) {
    if (error.code === 'ENOENT') {
      throw createError(codes.lockChanged, `${name} disappeared during validation: ${lockPath}`);
    }
    throw error;
  }

  let info;
  try {
    info = JSON.parse(content);
  }

  catch {
    throw createError(codes.corruptedLock, `${name} is corrupted: ${lockPath}`);
  }

  if (!Number.isSafeInteger(info?.pid) || info.pid <= 0 || typeof info?.token !== 'string' || !/^[a-f0-9]{32}$/.test(info.token)) {
    throw createError(codes.corruptedLock, `${name} data is invalid: ${lockPath}`);
  }

  return info;
}

function releaseWriterLock(lock, name = 'Writer lock') {
  let current;
  try {
    current = readWriterLock(lock.path, name);
  }

  catch (error) {
    if (error.code === codes.lockChanged) return false;
    throw error;
  }

  if (current.pid !== lock.pid || current.token !== lock.token) {
    throw createError(codes.lockOwnershipLost, `${name} belongs to another owner: ${lock.path}`);
  }

  try {
    fs.rmSync(lock.path);
  }

  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }

  return true;
}

function isProcessAlive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  }

  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

module.exports = {
  WriterLock
};
