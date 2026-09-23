'use strict';

const {MaxPathLength} = require('./constants.js');
const {codes,createError} = require('./errors.js');

function checkPath(value, allowRoot = false) {
  if (typeof value !== 'string') {
    throw createError(codes.invalidPath, 'Path must be a string');
  }

  if (/[\u0000-\u001F\u007F]/.test(value)) {
    throw createError(codes.invalidPath, 'Path contains control characters');
  }

  if (Buffer.byteLength(value, 'utf8') > MaxPathLength) {
    throw createError(codes.pathTooLong, `Path exceeds the ${MaxPathLength}-byte limit`);
  }

  const cleanedPath = value.trim().replace(/\\/g, '/');
  if (cleanedPath.startsWith('/') || /^[A-Za-z]:/.test(cleanedPath)) {
    throw createError(codes.invalidPath, 'Absolute and drive-relative paths are not allowed');
  }

  const segments = [];
  for (const rawSegment of cleanedPath.split('/')) {
    const segment = rawSegment.trim();
    if (!segment || segment === '.') continue;

    if (segment === '..') {
      throw createError(codes.invalidPath, 'Parent path segments are not allowed');
    }

    segments.push(segment);
  }

  const checkedPath = segments.join('/');
  if (!checkedPath) {
    if (allowRoot) return '';
    throw createError(codes.invalidPath, 'Path cannot be empty');
  }

  return checkedPath;
}

function checkJsonPath(value) {
  const checkedPath = checkPath(value);
  if (!checkedPath.toLowerCase().endsWith('.json')) {
    throw createError(codes.jsonExtensionRequired, 'JSON path must end with .json');
  }
  return checkedPath;
}

function getParentPath(value) {
  const separatorIndex = value.lastIndexOf('/');
  return separatorIndex === -1 ? null : value.slice(0, separatorIndex);
}

function getDirectoryChain(value) {
  const segments = value.split('/');
  const result = [];
  let current = '';
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    result.push(current);
  }
  return result;
}

module.exports = {
  checkPath,
  checkJsonPath,
  getParentPath,
  getDirectoryChain
};
