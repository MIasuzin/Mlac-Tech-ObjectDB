const fs = require('fs');
const {parentPort, workerData} = require('worker_threads');

const {open} = require('./database.js');
const {inspectDatabaseFile} = require('./recovery.js');
const {readStoredRecord} = require('./record.js');
const {createHeader} = require('./format.js');
const {readExactly, writeExactly} = require('./io.js');
const {dataOffset, indexOffset, recordTypes} = require('./constants.js');

let previousPaths;

function inspectSnapshot(sourceFd, endOffset, indexBuffer) {
  const inspection = inspectDatabaseFile(sourceFd, endOffset);
  if (inspection.truncatedBytes !== 0 || !inspection.rebuiltIndex.equals(Buffer.from(indexBuffer))) {
    const error = new Error('Снимок журнала не совпадает с подтверждённым индексом');
    error.code = 'corrupted_snapshot';
    throw error;
  }
  return inspection;
}

function build(snapshot) {
  const sourceFd = fs.openSync(workerData.sourcePath, 'r');
  let tempFd;
  let inspection;
  let minimumSaving;
  try {
    try {
      inspection = inspectSnapshot(sourceFd, snapshot.endOffset, snapshot.indexBuffer);
    }

    catch (error) {
      error.sourceCorrupted = true;
      throw error;
    }
    const journalSize = snapshot.endOffset - dataOffset;
    minimumSaving = Math.max(4 * 1024 * 1024, Math.floor(journalSize * 0.25));
    if (inspection.statistics.garbageBytes < minimumSaving) {
      parentPort.postMessage({type: 'skipped'});
      return;
    }

    tempFd = fs.openSync(workerData.tempPath, 'wx+');
    writeExactly(tempFd, createHeader(), 0);
    writeExactly(tempFd, Buffer.from(snapshot.indexBuffer), indexOffset);
    const chunk = Buffer.alloc(1024 * 1024);
    for (let offset = dataOffset; offset < snapshot.endOffset; offset += chunk.length) {
      const part = chunk.subarray(0, Math.min(chunk.length, snapshot.endOffset - offset));
      readExactly(sourceFd, part, offset);
      writeExactly(tempFd, part, offset);
    }
    fs.ftruncateSync(tempFd, snapshot.endOffset);
    fs.fsyncSync(tempFd);
    fs.closeSync(tempFd);
    tempFd = undefined;
  }

  finally {
    if (tempFd !== undefined) fs.closeSync(tempFd);
    fs.closeSync(sourceFd);
  }

  const database = open(workerData.tempPath, true);
  try {
    database.runOperation(() => database.compactInternal(), {recoverCorruptedIndex: false});
    database.verify();
  }

  finally {
    database.close();
  }
  if (snapshot.endOffset - fs.statSync(workerData.tempPath).size < minimumSaving) {
    parentPort.postMessage({type: 'skipped'});
    return;
  }
  previousPaths = inspection.livePaths;
  parentPort.postMessage({type: 'ready', endOffset: snapshot.endOffset, indexBuffer: snapshot.indexBuffer});
}

function catchup(snapshot) {
  const sourceFd = fs.openSync(workerData.sourcePath, 'r');
  let database;
  try {
    let inspection;
    try {
      inspection = inspectSnapshot(sourceFd, snapshot.endOffset, snapshot.indexBuffer);
    }

    catch (error) {
      error.sourceCorrupted = true;
      throw error;
    }
    database = open(workerData.tempPath, true);
    for (const [filePath, entry] of inspection.livePaths) {
      const old = previousPaths.get(filePath);
      if (old?.offset === entry.offset) continue;
      if (entry.type === recordTypes.DELETE) {
        if (old?.type === recordTypes.WRITE && database.delete(filePath) !== true) throw new Error('Не удалось перенести удаление');
        continue;
      }
      const record = readStoredRecord(sourceFd, entry.offset, snapshot.endOffset);
      if (entry.type === recordTypes.DIRECTORY) database.mkdir(filePath);
      else database.write(filePath, JSON.parse(record.dataBuffer.toString('utf8')));
    }
    database.verify();
    database.close();
    database = null;
    previousPaths = inspection.livePaths;
    parentPort.postMessage({type: 'ready', endOffset: snapshot.endOffset, indexBuffer: snapshot.indexBuffer});
  }

  finally {
    if (database) database.close();
    fs.closeSync(sourceFd);
  }
}

function reportError(error) {
  parentPort.postMessage({type: 'error', code: error.code || 'maintenance_failed', message: error.message, sourceCorrupted: error.sourceCorrupted === true});
}

parentPort.on('message', message => {
  if (message.type !== 'catchup') return;
  try {
    catchup(message);
  }

  catch (error) {
    reportError(error);
  }
});

try {
  build(workerData);
}

catch (error) {
  reportError(error);
}