'use strict';

const fs = require('fs');
const {codes, createError} = require('./errors.js');

function readExactly(fd, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const bytesRead = fs.readSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (bytesRead === 0) {
      throw createError(codes.unexpectedEof, `Unexpected end of file at offset ${position + offset}`);
    }
    offset += bytesRead;
  }
}

function writeExactly(fd, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const bytesWritten = fs.writeSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (bytesWritten === 0) {
      throw createError(codes.writeFailed, `Failed to continue writing at offset ${position + offset}`);
    }
    offset += bytesWritten;
  }
}

module.exports = {
  readExactly,
  writeExactly
};