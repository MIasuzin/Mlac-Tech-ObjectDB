> **机器翻译：** 本 README 由俄文原版自动翻译而成。

# 像使用 JSON 一样方便，像数据库一样可靠

`Mlac Tech ObjectDB` 用于存储小型 Node.js 应用的数据，适合在维护大量独立 JSON 文件开始变得不方便时使用。数据保存在一个 `.mtdb` 文件中，但在代码里仍然表现为文件夹中的 JSON 文档：可以读取、写入，并在事务中一起修改。

该库无需独立服务器即可工作，并会在崩溃后自动恢复已提交的记录、检查数据完整性并清理过期记录。用户只需打开数据库并直接操作文档。

![Mlac-Tech ObjectDB](docs/imgs/banner.png)
[Русский](README.md) · [English](docs/README.en.md) · [فارسی](docs/README.fa.md) · [简体中文](docs/README.zh-CN.md) · [Български](docs/README.bg.md)

## 功能

* 单个 `.mtdb` 数据库文件
* 简单的同步 API
* 存储普通 JSON 数据
* 数据库内部的虚拟目录
* Append-only 变更日志
* 通过 `RECORD + COMMIT + fsync` 实现可靠写入
* 异常终止后的自动恢复
* 每条记录都进行 CRC32 完整性校验
* 可重建的 hash 索引，包含 65,536 个 buckets
* 从日志中自动恢复损坏的索引
* 防止多个进程同时写入
* 自动恢复失效的 writer-lock
* 防止进程之间的 writer-lock 竞争
* 防止通过 symbolic link 和 hard link 绕过锁
* 通过临时文件安全创建新数据库
* 压缩时删除旧版本和 tombstone 记录
* 完成压缩前验证新文件
* 提供明确的错误代码，便于程序处理
* 无 runtime 依赖
* CommonJS API

## 核心方法

```js
const mtdb = require('@mlasuzin/mtdb');

const db = mtdb.open('./data.mtdb');
```

数据库公开 API：

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

打开现有数据库，或在不存在时创建新数据库。

```js
const db = mtdb.open('./data.mtdb');
```

路径必须以 `.mtdb` 结尾。

打开数据库时，MTDB 会获取独占 writer-lock，因此同一个数据库文件同一时间只能由一个 writer 进程使用。

如果上一个进程异常退出，下一次打开数据库时会自动执行所需的恢复。

返回数据库实例。

---

### `db.mkdir(path)`

创建虚拟目录，也可以一次创建整条缺失的目录链。

```js
db.mkdir('users');
db.mkdir('users/archive/old');
```

如果至少创建了一个目录则返回 `true`；如果整条目录链都已存在则返回 `false`。

根目录会自动存在，不需要手动创建。

---

### `db.rmdir(path)`

删除数据库中的虚拟目录。

```js
db.rmdir('users/archive/old');
db.rmdir('users/archive');
```

如果目录存在并已删除则返回 `true`；如果目录不存在则返回 `false`。

只删除指定目录。根目录不能删除。

---

### `db.has(path)`

在不读取和解析内容的情况下检查 JSON 文档是否存在。

```js
db.has('users/1.json');
```

文档存在时返回 `true`；文档不存在或已被删除时返回 `false`。

与 `read()` 不同，该方法不会执行 `JSON.parse()`，适合快速检查数据是否存在。

---

### `db.list(path, options)`

返回目录内按顺序排序的 JSON 文档列表。

```js
db.list('users');
```

默认情况下不会递归搜索：

```js
[
  'users/1.json',
  'users/2.json'
]
```

如需获取所有子目录中的文档：

```js
db.list('users', {
  recursive: true
});
```

根目录使用空字符串表示：

```js
db.list('');
```

该方法返回 `string[]`。

---

### `db.read(path)`

读取 JSON 文档并返回其中保存的 JavaScript 值。

```js
const user = db.read('users/1.json');
```

如果文档不存在或已被删除：

```js
undefined
```

JSON 会通过 `JSON.parse()` 自动解析。

---

### `db.write(path, value)`

创建新的 JSON 文档，或替换已有文档。

```js
db.write('users/1.json', {
  id: 1,
  name: 'Mlasuzin'
});
```

值会通过 `JSON.stringify()` 序列化。

对于嵌套文档，其父目录必须已经存在：

```js
db.mkdir('users');

db.write('users/1.json', {
  id: 1
});
```

文档路径必须以 `.json` 结尾。

序列化后 JSON 的最大大小为 `100 MiB`。

写入成功后返回 `true`。

---

### `db.delete(path)`

删除 JSON 文档。

```js
db.delete('users/1.json');
```

返回：

* `true` — 文档存在并已被删除；
* `false` — 文档不存在或已经被删除。

删除后，`db.read(path)` 返回 `undefined`。

---

### `db.transaction(handler)`

将多个修改作为一个原子操作执行。

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

事务内部可以使用：

```js
tx.read(path);
tx.write(path, value);
tx.delete(path);
```

`tx.read()` 可以看到同一事务中已经完成的修改。

只有 callback 成功执行完成后，修改才会提交。如果 callback 抛出错误，事务不会写入。

Callback 必须是同步的。不支持 `async` 函数和 `Promise`，也不允许嵌套事务。

`db.transaction()` 返回 callback 返回的值：

```js
const result = db.transaction((tx) => {
  tx.write('settings.json', {
    enabled: true
  });

  return 'saved';
});

console.log(result); // saved
```

单个事务最多可包含 `1000` 个被修改的路径，以及最多 `128 MiB` 的暂存数据。

---

### `db.verify()`

完整检查数据库完整性。

```js
const result = db.verify();
```

会检查文件结构、metadata、日志、记录、checksums、事务，以及 hash 索引与已提交数据是否一致。

数据库有效时返回一个对象：

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

如果检测到损坏或不一致，该方法会抛出对应的 MTDB 错误。

`verify()` 会对文件执行完整的同步检查，因此对于大型数据库可能是开销较大的操作。

---

### `db.stats()`

返回数据库当前状态的统计信息。

```js
const stats = db.stats();
```

结果：

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

主要字段：

* `fileSize` — `.mtdb` 文件的物理大小；
* `files` — 当前有效 JSON 文档数量；
* `directories` — 目录数量；
* `liveRecords` — 当前有效记录数量；
* `garbageRecords` — 过期记录数量；
* `liveBytes` — 当前有效数据大小；
* `garbageBytes` — 过期数据大小；
* `garbageRatio` — 文件中过期数据所占比例。

为了获取统计信息，MTDB 同样会检查数据库完整性，因此 `stats()` 是一个会完整扫描日志的同步操作。

---

### `db.close()`

正确关闭数据库并释放 writer-lock。

```js
db.close();
```

第一次成功调用返回：

```js
true
```

再次调用返回：

```js
false
```

数据库关闭后，该实例不能继续使用。

---

### 快速参考

| 方法 | 用途 | 返回值 |
| --- | --- | --- |
| `mtdb.open(filePath)` | 打开或创建数据库 | `Database` |
| `db.mkdir(path)` | 创建目录或目录链 | `boolean` |
| `db.list(path, options)` | 返回目录内的 JSON 文档 | `string[]` |
| `db.read(path)` | 读取 JSON 文档 | value / `undefined` |
| `db.write(path, value)` | 创建或覆盖 JSON | `true` |
| `db.delete(path)` | 删除 JSON 文档 | `boolean` |
| `db.transaction(handler)` | 原子执行一组修改 | `handler` 的返回值 |
| `db.verify()` | 检查数据库完整性 | `object` |
| `db.stats()` | 返回数据库统计信息 | `object` |
| `db.close()` | 关闭数据库并释放 writer-lock | `boolean` |

压缩不是公开 API 的一部分。MTDB 会在需要时在库内部自动执行。

## 使用示例

可以将 MTDB 用作小型 Node.js 服务的本地状态存储。

在这个示例中，数据库保存用户、用户设置和活动会话。

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

这里 MTDB 被当作普通的嵌入式应用存储使用，不需要独立数据库服务器，也无需手动管理一组 JSON 文件。

## 文档

详细文档位于仓库中：

```text
API.md
ERRORS.md
FORMAT.md
CHANGELOG.md
```

* `API.md` — 完整的公开 API；
* `ERRORS.md` — 错误和恢复规则；
* `FORMAT.md` — `.mtdb` 二进制格式；
* `CHANGELOG.md` — 变更历史。

## 要求

```text
Node.js >= 18
```

无 runtime 依赖。

## 许可证

Apache-2.0
