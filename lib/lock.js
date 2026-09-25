'use strict';

const fs = require('fs');
const crypto = require('crypto');
const {execFileSync} = require('child_process');
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
      if (error.code === codes.corruptedLock) {
        if (!removeExpiredLock(lockPath)) {
          throw createError(codes.databaseLocked, `Writer lock is incomplete or corrupted: ${lockPath}`);
        }
      }

      else if (error.code !== codes.lockChanged) {
        throw error;
      }
    }

    if (current) {
      if (isLockOwnerAlive(current)) {
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
        if (removeExpiredLock(guardPath)) continue;
        throw createError(codes.databaseLocked, `Writer lock creation is already in progress: ${guardPath}`);
      }

      throw error;
    }

    if (isLockOwnerAlive(current)) {
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

function removeExpiredLock(lockPath) {
  let original;
  try {
    original = fs.lstatSync(lockPath);
  }

  catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }

  if (!original.isFile() || Date.now() - original.mtimeMs < 30_000) return false;

  let current;
  try {
    current = fs.lstatSync(lockPath);
  }

  catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }

  if (current.dev !== original.dev || current.ino !== original.ino ||
      current.size !== original.size || current.mtimeMs !== original.mtimeMs) {
    return false;
  }

  try {
    fs.rmSync(lockPath);
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
  const identity = getOwnProcessIdentity();
  if (!identity) {
    throw createError(codes.databaseLocked, 'Cannot determine process identity for a safe writer lock');
  }

  const info = {
    pid: process.pid,
    token: crypto.randomBytes(16).toString('hex'),
    identity
  };
  const tempPath = `${lockPath}.${info.token}.tmp`;
  const data = Buffer.from(`${JSON.stringify(info)}\n`, 'utf8');
  let fd;

  try {
    fd = fs.openSync(tempPath, 'wx');
    writeExactly(fd, data, 0);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    fs.linkSync(tempPath, lockPath);
    return {path: lockPath, ...info};
  }

  finally {
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

  if (!Number.isSafeInteger(info?.pid) || info.pid <= 0 ||
      typeof info.token !== 'string' || !/^[a-f0-9]{32}$/.test(info.token) ||
      (info.identity !== undefined && (typeof info.identity !== 'string' || info.identity.length === 0 || info.identity.length > 160))) {
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

let ownProcessIdentity;

function getOwnProcessIdentity() {
  if (ownProcessIdentity === undefined) ownProcessIdentity = getProcessIdentity(process.pid);
  return ownProcessIdentity;
}

function getProcessIdentity(pid) {
  try {
    if (process.platform === 'linux') {
      const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      return bootId && /^\d+$/.test(fields[19]) ? `linux:${bootId}:${fields[19]}` : null;
    }

    if (process.platform === 'win32') {
      const command = `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue | ForEach-Object { $_.StartTime.ToUniversalTime().Ticks }).ToString()`;
      const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      return /^\d+$/.test(result) ? `win32:${result}` : null;
    }

    if (process.platform === 'darwin') {
      const result = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      return result ? `darwin:${result}` : null;
    }
  }

  catch {
    return null;
  }

  return null;
}

function isLockOwnerAlive(info) {
  if (!isProcessAlive(info.pid)) return false;
  if (info.identity === undefined) return true;

  const identity = getProcessIdentity(info.pid);
  return identity === null || identity === info.identity;
}

module.exports = {
  WriterLock
};