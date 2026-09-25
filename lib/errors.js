'use strict';

const codes = Object.freeze({
  databaseLocked: 'MTDB_DATABASE_LOCKED',
  closed: 'closed',
  compactFailed: 'compact_failed',
  compactValidationFailed: 'compact_validation_failed',
  corruptedFile: 'corrupted_file',
  corruptedIndex: 'corrupted_index',
  corruptedJson: 'corrupted_json',
  corruptedLock: 'corrupted_lock',
  corruptedLog: 'corrupted_log',
  corruptedRecord: 'corrupted_record',
  directoryNotFound: 'directory_not_found',
  fileChanged: 'file_changed',
  hardlinkUnsupported: 'hardlink_unsupported',
  invalidFileExtension: 'invalid_file_extension',
  invalidFilePath: 'invalid_file_path',
  invalidHeader: 'invalid_header',
  invalidHeaderState: 'invalid_header_state',
  invalidIndex: 'invalid_index',
  invalidListOptions: 'invalid_list_options',
  invalidTransaction: 'MTDB_INVALID_TRANSACTION',
  asyncTransactionNotSupported: 'MTDB_ASYNC_TRANSACTION_NOT_SUPPORTED',
  nestedTransaction: 'MTDB_NESTED_TRANSACTION',
  transactionClosed: 'MTDB_TRANSACTION_CLOSED',
  transactionTooLarge: 'MTDB_TRANSACTION_TOO_LARGE',
  invalidJson: 'invalid_json',
  invalidMagic: 'invalid_magic',
  invalidPath: 'invalid_path',
  invalidRecordData: 'invalid_record_data',
  invalidRecordOffset: 'invalid_record_offset',
  invalidRecordPath: 'invalid_record_path',
  invalidRecordType: 'invalid_record_type',
  jsonExtensionRequired: 'json_extension_required',
  jsonTooLarge: 'json_too_large',
  lockChanged: 'lock_changed',
  lockOwnershipLost: 'lock_ownership_lost',
  operationOutcomeUnknown: 'operation_outcome_unknown',
  pathIsDirectory: 'path_is_directory',
  pathIsFile: 'path_is_file',
  pathNotFile: 'path_not_file',
  pathTooLong: 'path_too_long',
  recoveryRequired: 'recovery_required',
  reentrantOperation: 'reentrant_operation',
  symlinkUnsupported: 'symlink_unsupported',
  unexpectedEof: 'unexpected_eof',
  unsupportedVersion: 'unsupported_version',
  writeFailed: 'write_failed'
});

function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  codes,
  createError
};