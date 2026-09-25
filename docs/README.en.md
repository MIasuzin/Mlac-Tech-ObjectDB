> **Machine translation:** This README was automatically translated from the original Russian version.

# JSON with the convenience and reliability of a database

`Mlac Tech ObjectDB` helps store data for small Node.js applications when maintaining separate JSON files becomes inconvenient. The data lives in a single `.mtdb` file, but in code it looks like JSON documents in folders: you can read, write, and modify them together in transactions.

The library works without a separate server, automatically recovers committed records after a crash, verifies data integrity, and removes obsolete records. You only need to open the database and work with documents.

![Mlac-Tech ObjectDB](imgs/banner.png)
[Русский](README.md) · [English](docs/README.en.md) · [فارسی](docs/README.fa.md) · [简体中文](docs/README.zh-CN.md) · [Български](docs/README.bg.md)

## Features

* Single `.mtdb` database file
* Simple synchronous API
* Storage of regular JSON data
* Virtual directories inside the database
* Append-only change journal
* Durable writes through `RECORD + COMMIT + fsync`
* Automatic recovery after an unexpected shutdown
* CRC32 integrity check for every record
* Rebuildable hash index with 65,536 buckets
* Automatic recovery of a damaged index from the journal
* Protection against simultaneous writes from multiple processes
* Automatic recovery of stale writer locks
* Protection against writer-lock races between processes
* Protection against bypassing the lock through symbolic links and hard links
* Safe creation of a new database through a temporary file
* Compaction that removes old versions and tombstone records
* Verification of the new file before compaction is completed
* Explicit error codes for programmatic handling
* No runtime dependencies
* CommonJS API

## Core library methods

```js
const mtdb = require('@mlasuzin/mtdb');

const db = mtdb.open('./data.mtdb');
```

Public database API:

```js
db.mkdir(path);
db.rmdir(path);
db.has(path);
db.list(path, options);
db.read(path);
db.write(path, value);
db.delete(path);
db.transaction(handler);
db.verify();
db.stats();
db.close();
```

### `mtdb.open(filePath)`

Opens an existing database or creates a new one.

```js
const db = mtdb.open('./data.mtdb');
```

The path must end with `.mtdb`.

When opened, MTDB acquires an exclusive writer lock, so a database file can be used by only one writer process at a time.

After an abnormal termination of the previous process, the required recovery is performed automatically the next time the database is opened.

Returns a database instance.

---

### `db.mkdir(path)`

Creates a virtual directory or the entire missing directory chain.

```js
db.mkdir('users');
db.mkdir('users/archive/old');
```

Returns `true` if at least one directory was created, and `false` if the entire chain already existed.

The root directory exists automatically and does not need to be created.

---

### `db.rmdir(path)`

Removes a virtual directory from the database.

```js
db.rmdir('users/archive/old');
db.rmdir('users/archive');
```

Returns `true` if the directory existed and was removed, and `false` if the directory does not exist.

Only the specified directory is removed. The root directory cannot be removed.

---

### `db.has(path)`

Checks whether a JSON document exists without reading or parsing its contents.

```js
db.has('users/1.json');
```

Returns `true` if the document exists, and `false` if it does not exist or has been deleted.

Unlike `read()`, this method does not call `JSON.parse()` and is suitable for quickly checking whether data exists.

---

### `db.list(path, options)`

Returns a sorted list of JSON documents inside a directory.

```js
db.list('users');
```

By default, the search is not recursive:

```js
[
  'users/1.json',
  'users/2.json'
]
```

To include documents from all nested directories:

```js
db.list('users', {
  recursive: true
});
```

The root directory is represented by an empty string:

```js
db.list('');
```

The method returns `string[]`.

---

### `db.read(path)`

Reads a JSON document and returns the stored JavaScript value.

```js
const user = db.read('users/1.json');
```

If the document does not exist or has been deleted:

```js
undefined
```

JSON is parsed automatically with `JSON.parse()`.

---

### `db.write(path, value)`

Creates a new JSON document or replaces an existing one.

```js
db.write('users/1.json', {
  id: 1,
  name: 'Mlasuzin'
});
```

The value is serialized with `JSON.stringify()`.

For a nested document, the parent directory must already exist:

```js
db.mkdir('users');

db.write('users/1.json', {
  id: 1
});
```

The document path must end with `.json`.

The maximum serialized JSON size is `100 MiB`.

Returns `true` after a successful write.

---

### `db.delete(path)`

Deletes a JSON document.

```js
db.delete('users/1.json');
```

Returns:

* `true` — the document existed and was deleted;
* `false` — the document does not exist or has already been deleted.

After deletion, `db.read(path)` returns `undefined`.

---

### `db.transaction(handler)`

Performs multiple changes as a single atomic operation.

```js
db.transaction((tx) => {
  const user = tx.read('users/1.json');

  tx.write('users/1.json', {
    ...user,
    balance: user.balance - 100
  });

  tx.write('users/2.json', {
    balance: 100
  });

  tx.delete('users/old.json');
});
```

Inside a transaction, the following methods are available:

```js
tx.read(path);
tx.write(path, value);
tx.delete(path);
```

`tx.read()` sees changes already made within the same transaction.

Changes are committed only after the callback completes successfully. If the callback throws an error, the transaction is not written.

The callback must be synchronous. `async` functions and `Promise` are not supported. Nested transactions are also not allowed.

`db.transaction()` returns the value returned by the callback:

```js
const result = db.transaction((tx) => {
  tx.write('settings.json', {
    enabled: true
  });

  return 'saved';
});

console.log(result); // saved
```

A single transaction can contain up to `1000` changed paths and up to `128 MiB` of staged data.

---

### `db.verify()`

Performs a full integrity check of the database.

```js
const result = db.verify();
```

The file structure, metadata, journal, records, checksums, transactions, and correspondence of the hash index to committed data are verified.

For a valid database, an object is returned:

```js
{
  valid: true,
  fileSize,
  metadataSlots,
  records,
  commits,
  files,
  directories,
  liveRecords,
  garbageRecords,
  liveBytes,
  garbageBytes,
  garbageRatio
}
```

If corruption or an inconsistency is detected, the method throws the corresponding MTDB error.

`verify()` performs a full synchronous file check and can be an expensive operation for a large database.

---

### `db.stats()`

Returns statistics for the current database state.

```js
const stats = db.stats();
```

Result:

```js
{
  fileSize,
  records,
  commits,
  files,
  directories,
  liveRecords,
  garbageRecords,
  liveBytes,
  garbageBytes,
  garbageRatio
}
```

Main values:

* `fileSize` — physical size of the `.mtdb` file;
* `files` — number of current JSON documents;
* `directories` — number of directories;
* `liveRecords` — number of current records;
* `garbageRecords` — number of obsolete records;
* `liveBytes` — size of current data;
* `garbageBytes` — size of obsolete data;
* `garbageRatio` — share of obsolete data in the file.

To collect statistics, MTDB also verifies database integrity, so `stats()` is a synchronous operation that performs a full journal scan.

---

### `db.close()`

Closes the database correctly and releases the writer lock.

```js
db.close();
```

The first successful call returns:

```js
true
```

A subsequent call returns:

```js
false
```

After closing, the database instance can no longer be used.

---

### Quick reference

| Method | Purpose | Result |
| --- | --- | --- |
| `mtdb.open(filePath)` | Opens or creates a database | `Database` |
| `db.mkdir(path)` | Creates a directory or directory chain | `boolean` |
| `db.list(path, options)` | Returns JSON documents inside a directory | `string[]` |
| `db.read(path)` | Reads a JSON document | value / `undefined` |
| `db.write(path, value)` | Creates or overwrites JSON | `true` |
| `db.delete(path)` | Deletes a JSON document | `boolean` |
| `db.transaction(handler)` | Atomically performs a group of changes | `handler` result |
| `db.verify()` | Verifies database integrity | `object` |
| `db.stats()` | Returns database statistics | `object` |
| `db.close()` | Closes the database and releases the writer lock | `boolean` |

Compaction is not part of the public API. MTDB performs it automatically inside the library when needed.

## Usage example

It can be used as local state storage for a small Node.js service.

In this example, the database stores users, their settings, and active sessions.

```js
const crypto = require('crypto');
const mtdb = require('@mlasuzin/mtdb');

const db = mtdb.open('./app.mtdb');

try {
  db.mkdir('users');
  db.mkdir('sessions');

  function createUser(id, name) {
    const directory = `users/${id}`;
    if (db.has(`${directory}/profile.json`)) {
      throw new Error('User already exists');
    }

    db.mkdir(directory);

    db.write(`${directory}/profile.json`, {
      id,
      name,
      createdAt: Date.now(),
      lastLoginAt: null
    });

    db.write(`${directory}/settings.json`, {
      language: 'ru',
      notifications: true
    });
  }

  function login(id) {
    const profilePath = `users/${id}/profile.json`;
    if (!db.has(profilePath)) {
      throw new Error('User not found');
    }

    const sessionId = crypto.randomUUID();
    const profile = db.read(profilePath);

    db.transaction((tx) => {
      tx.write(profilePath, {
        ...profile,
        lastLoginAt: Date.now()
      });

      tx.write(`sessions/${sessionId}.json`, {
        userId: id,
        createdAt: Date.now()
      });
    });

    return sessionId;
  }

  function updateSettings(id, settings) {
    const path = `users/${id}/settings.json`;
    const current = db.read(path);
    db.write(path, {
      ...current,
      ...settings
    });
  }

  function logout(sessionId) {
    return db.delete(`sessions/${sessionId}.json`);
  }

  function deleteUser(id) {
    const directory = `users/${id}`;
    for (const path of db.list(directory, {
      recursive: true
    })) 

    {
      db.delete(path);
    }

    return db.rmdir(directory);
  }

  createUser('42', 'Alex');

  updateSettings('42', {language: 'en'});
  const sessionId = login('42');
  console.log(
    db.read('users/42/profile.json')
  );

  console.log(
    db.list('users', {
      recursive: true
    })
  );

  logout(sessionId);
  console.log(db.stats());
  console.log(db.verify());
  deleteUser('42');
}

finally {
  db.close();
}
```

Here MTDB is used as regular embedded application storage without a separate database server and without manually managing a collection of JSON files.

## Documentation

Detailed documentation is available in the repository:

```text
API.md
ERRORS.md
FORMAT.md
CHANGELOG.md
```

* `API.md` — complete public API;
* `ERRORS.md` — errors and recovery rules;
* `FORMAT.md` — binary `.mtdb` format;
* `CHANGELOG.md` — change history.

## Requirements

```text
Node.js >= 18
```

There are no runtime dependencies.

## License

Apache-2.0
