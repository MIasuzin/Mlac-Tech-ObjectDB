# Changelog

All notable changes to MTDB are documented in this file.

The project follows semantic versioning for published package versions.

## [Unreleased] — формат файла v3

### Добавлено

* `db.transaction(handler)` с синхронными `tx.read()`, `tx.write()` и `tx.delete()`, атомарной фиксацией изменений и чтением собственных подготовленных изменений. Публичный предел — 1000 путей и 128 MiB.
* Записи `TX_BEGIN` и `TX_COMMIT` формата файла v3 с CRC32 целой транзакционной группы; восстановление применяет только полные подтверждённые группы.
* `db.rmdir(path, {recursive: true})` с атомарным удалением поддерева. Внутренний предел — 100 000 дочерних записей и удаляемый каталог при общем пределе 128 MiB.
* `db.has(path)` для документов, каталогов и неявного корня; `db.rmdir(path)` для пустого каталога.
* `db.verify()` для полной проверки файла и `db.stats()` для статистики и диагностики фонового обслуживания.
* Два слота метаданных в заголовке с номерами поколений и CRC32, размером файла и контрольной суммой индекса.
* Индекс корзин размером 512 KiB и индекс живых путей в оперативной памяти. Последний собирается из журнала при открытии и обновляется после фиксации записей.
* Отдельные коды ошибок для транзакций, удаления каталогов и параметров `list()`/`rmdir()`.

### Изменено

* Публичный `db.compact()` удалён. Библиотека выполняет обслуживание автоматически в фоновом потоке, проверяет результат до замены базы и отражает ошибку в `db.stats().maintenanceError`.
* Открытие базы v2 для обычной работы требует отдельной офлайн-миграции; `mtdb.open()` работает с форматом v3. Публичное открытие больше не выполняет миграцию неявно.
* `db.list(path, {recursive: true})` поддерживает получение документов из вложенных каталогов.
* Индекс живых путей исключает проход всей цепочки корзины для поиска по конкретному пути. Цена — полный проход журнала при `open()` и память, пропорциональная числу живых путей.
* После успешной одиночной записи или транзакции журнал и индекс синхронизируются раздельно; аварийное восстановление проверяет подтверждения, а не доверяет одному лишь индексу.

### Исправлено

* Файл блокировки создаётся полностью во временном файле и публикуется атомарно. Старый неполный lock после сбоя восстанавливается после проверки времени ожидания.
* Новые lock записывают идентификатор запуска процесса в дополнение к PID, чтобы повторно использованный PID не удерживал устаревшую блокировку. Если идентификатор недоступен, открытие не снимает сомнительную блокировку.
* Рекурсивное удаление каталога с 1000 дочерними записями больше не упирается в публичный предел размера транзакции; восстановление понимает отдельный внутренний предел.
* Временная ошибка чтения, например `EIO`, в потоке обслуживания больше не помечается автоматически как подтверждённая порча основной базы.

### Ограничения текущей версии

* API синхронный; один процесс-писатель на базу; публичного режима одновременного чтения другими процессами нет.
* Нет вторичных индексов, языка запросов и публичного ручного управления компактизацией.
* Для проверки PID на Windows используется установленный системный PowerShell. На macOS определение времени запуска через `ps` ограничено точностью этой команды. Старый корректный lock без идентификатора процесса может потребовать однократного ручного разбора при повторном использовании PID.
* Успешные `fsync` и переименование зависят от гарантий операционной системы и носителя.

## [0.3.0-rc.2]

Промежуточный кандидат v2. Подробные изменения этой публикации в исходном журнале изменений не были выделены отдельной записью.

## [0.3.0-rc.1]

First release candidate of the current MTDB v2 storage engine.

### Added

* Added MTDB file format version 2.
* Added fixed 4096-byte database header.
* Added 65,536-bucket hash index.
* Added append-only record journal.
* Added `DIRECTORY`, `WRITE`, `DELETE` and `COMMIT` record types.
* Added CRC32 validation for journal records.
* Added FNV-1a path hashing.
* Added explicit virtual directories.
* Added implicit root directory.
* Added `db.mkdir(path)`.
* Added `db.list(path)`.
* Added root listing through `db.list('')`.
* Added `db.read(path)`.
* Added `db.write(path, value)`.
* Added `db.delete(path)`.
* Added `db.compact()`.
* Added `db.close()`.
* Added crash recovery for databases left in `DIRTY` state.
* Added index reconstruction from committed journal records.
* Added truncation of incomplete uncommitted journal tails.
* Added corruption detection for record headers, checksums, paths and commit structure.
* Added validation that bucket-chain records belong to the expected hash bucket.
* Added automatic recovery from damaged bucket offsets when the journal remains valid.
* Added compact-file validation before replacing the active database.
* Added crash-safe creation through `.create.tmp`.
* Added compact replacement through `.compact.tmp`.
* Added same-process duplicate-open protection.
* Added cross-process writer locking.
* Added stale writer-lock recovery.
* Added writer-lock ownership tokens.
* Added `.lock.guard` protection for stale-lock recovery.
* Added protection against opening writer databases through symbolic links.
* Added protection against hard-linked database files.
* Added recovery-required runtime state after unsafe mutation failures.
* Added reentrant-operation protection.
* Added path normalization for `/` and `\`.
* Added rejection of absolute paths, drive paths, drive-relative paths, empty segments, `.` and `..`.
* Added maximum normalized path size of 1024 UTF-8 bytes.
* Added maximum serialized JSON size of 100 MiB.
* Added explicit MTDB error codes.
* Added crash/recovery tests.
* Added compact crash tests.
* Added collision-chain tests.
* Added corruption tests.
* Added writer-lock tests.
* Added `list()` tests.
* Added regression tests for recovery-required state, reentrancy, hash-bucket validation, path rules, writer aliases and crash-safe creation.
* Added stress and endurance test coverage.

### Changed

* Changed database mutations to use an explicit `RECORD + COMMIT` durability protocol.
* Changed the on-disk bucket index into a rebuildable acceleration structure rather than the only source of current state.
* Changed database open behavior so `DIRTY` databases are recovered before use.
* Changed database close behavior so `CLEAN` is written only when the current runtime state is considered safe.
* Changed mutation failure behavior so an unsafe instance enters `MTDB_RECOVERY_REQUIRED`.
* Changed `compact()` to retain only the current logical state.
* Changed compact processing to retain record offsets instead of keeping all current JSON payloads for a bucket in memory.
* Changed writer protection from process-local only to process-local plus cross-process locking.
* Changed path handling so trailing separators are rejected instead of silently removed.
* Changed Windows drive-relative paths such as `C:foo.json` to be explicitly rejected.
* Changed `list()` semantics to support the implicit root with an empty path.
* Changed corruption handling so valid records referenced from the wrong bucket are treated as index corruption.
* Changed reentrant calls so they are rejected before entering the operation queue.

### Fixed

* Fixed a recovery integrity issue where a second mutation could run after a failed first mutation and create an unrecoverable journal chain.
* Fixed reentrant operations remaining queued after the caller had already received `MTDB_REENTRANT_OPERATION`.
* Fixed writer-lock bypass through symbolic-link aliases.
* Fixed writer-lock bypass through hard-linked database aliases.
* Fixed a stale-lock recovery race that could allow one process to remove another process's newly created writer-lock.
* Fixed partial first-time database creation leaving a corrupted final `.mtdb` file.
* Fixed bucket traversal accepting valid records belonging to another hash bucket.
* Fixed trailing-slash paths being silently normalized into valid paths.
* Fixed Windows drive-relative paths being accepted.
* Fixed the inability to enumerate JSON documents stored directly in the implicit root.
* Reduced peak memory usage during compaction of heavily collided buckets.

### Recovery and durability

MTDB v2 uses the following mutation sequence:

```text
mark DIRTY
write ordinary record
write COMMIT
fsync
update bucket index
fsync
```

Only mutations confirmed by a valid `COMMIT` record are applied during recovery.

Incomplete uncommitted data at the end of the journal is discarded.

Confirmed historical corruption is reported instead of silently ignored.

### Compaction

Compaction now:

* scans current bucket chains;
* keeps only the newest logical record for each path;
* removes tombstones;
* removes historical overwritten versions;
* rebuilds bucket chains;
* writes matching COMMIT records;
* validates the resulting database;
* replaces the active database only after validation succeeds.

### Writer locking

Writer protection now covers:

* duplicate opens in one process;
* competing writer processes;
* stale locks after terminated processes;
* symbolic-link aliases;
* hard-linked database files;
* races during stale-lock cleanup.

MTDB intentionally fails closed if writer ownership cannot be determined safely.

### Known limitations of v2 (historical)

* API is synchronous.
* Only one writer is supported per database.
* Read-only concurrent access is not yet exposed as a public API.
* JSON is the only supported document format.
* Transactions are not supported.
* Secondary indexes are not supported.
* Query APIs are not supported.
* Directory deletion is not supported.
* Automatic compaction is not implemented.
* Physical power-loss guarantees during filesystem rename depend on the operating system, filesystem and storage hardware.

## [0.2.0]

Previous development version.

Detailed historical changes for this version were not formally recorded.
