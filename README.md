# MTDB

MTDB is a compact single-file JSON storage library for Node.js.

It provides a synchronous filesystem-like API for storing JSON documents inside a single `.mtdb` file, with crash recovery, checksums, compaction and single-writer protection.

![Mlac-Tech ObjectDB](docs/imgs/banner.png)

```js
const mtdb = require('mtdb');

const db = mtdb.open('./data.mtdb');

db.mkdir('users');

db.write('users/1.json', {
  id: 1,
  name: 'Alice'
});

console.log(
  db.read('users/1.json')
);

db.close();
```

## Features

* Single `.mtdb` database file
* Synchronous API
* JSON document storage
* Virtual directories
* Crash recovery
* Record checksums
* Durable writes with commit records
* Rebuildable hash index
* Single-writer protection between processes
* Automatic stale writer-lock recovery
* Database compaction
* No runtime dependencies
* CommonJS API

## Installation

```bash
npm install @mlasuzin/mtdb
```

## Быстрый старт

```js
'use strict';

const mtdb = require('@mlasuzin/mtdb');

const db = mtdb.open('./data.mtdb');

db.mkdir('users');

db.write('users/1.json', {
  name: 'Mlasuzin',
  city: 'Kharkiv',
  role: 'developer'
});

const user = db.read('users/1.json');

console.log(user);

db.close();
```

Результат:

```js
{
  name: 'Mlasuzin',
  city: 'Kharkiv',
  role: 'developer'
}
```

Если `data.mtdb` ещё не существует, MTDB создаст его автоматически.

## Работа с данными

### Создание пользователя

Сначала создадим виртуальный каталог:

```js
db.mkdir('users');
```

Теперь сохраним пользователя:

```js
db.write('users/1.json', {
  name: 'Mlasuzin',
  city: 'Kharkiv',
  role: 'developer'
});
```

`write()` принимает обычное JavaScript-значение и сериализует его через `JSON.stringify()`.

### Чтение пользователя

```js
const user = db.read('users/1.json');

console.log(user);
```

Получим:

```js
{
  name: 'Mlasuzin',
  city: 'Kharkiv',
  role: 'developer'
}
```

Если документ не существует, `read()` возвращает:

```js
undefined
```

### Изменение данных

Чтобы изменить пользователя, достаточно прочитать документ, изменить его и записать обратно.

Например, перенесём пользователя из Kharkiv в Stara Zagora:

```js
const user = db.read('users/1.json');

user.city = 'Stara Zagora';

db.write('users/1.json', user);
```

После этого:

```js
console.log(db.read('users/1.json'));
```

вернёт:

```js
{
  name: 'Mlasuzin',
  city: 'Stara Zagora',
  role: 'developer'
}
```

Старое значение физически может оставаться в журнале базы до выполнения `compact()`.

### Добавление второго пользователя

```js
db.write('users/2.json', {
  name: 'Alice',
  city: 'Sofia',
  role: 'designer'
});
```

### Получение списка пользователей

```js
const users = db.list('users');

console.log(users);
```

Результат:

```js
[
  'users/1.json',
  'users/2.json'
]
```

`list()` возвращает только документы непосредственно внутри указанного каталога и не выполняет рекурсивный обход.

Например:

```text
users/
├── 1.json
├── 2.json
└── archive/
    └── 3.json
```

Вызов:

```js
db.list('users');
```

вернёт только:

```js
[
  'users/1.json',
  'users/2.json'
]
```

### Удаление пользователя

```js
const deleted = db.delete('users/2.json');

console.log(deleted);
```

Если документ существовал:

```js
true
```

Если документа уже нет:

```js
false
```

После удаления:

```js
db.read('users/2.json');
```

вернёт:

```js
undefined
```

Физически MTDB записывает tombstone. Старые данные удаляются при последующем `compact()`.

## Каталоги

Корневой каталог существует неявно.

Поэтому можно сразу записывать JSON в root:

```js
db.write('settings.json', {
  enabled: true
});
```

Для вложенных документов родительский каталог должен существовать:

```js
db.mkdir('users');

db.write('users/1.json', {
  name: 'Mlasuzin'
});
```

`mkdir()` умеет создавать всю цепочку каталогов:

```js
db.mkdir('data/users/archive');
```

Будут созданы:

```text
data
data/users
data/users/archive
```

Повторное создание существующего каталога безопасно:

```js
db.mkdir('users'); // true
db.mkdir('users'); // false
```

## Пути

Внутри MTDB используются относительные пути:

```text
settings.json
users/1.json
users/archive/100.json
```

Обратный слеш автоматически преобразуется в `/`.

Поэтому:

```js
db.read('users\\1.json');
```

эквивалентно:

```js
db.read('users/1.json');
```

JSON-пути должны заканчиваться на `.json`.

Допустимо:

```text
users/1.json
settings.JSON
data/items/test.Json
```

Абсолютные пути и переходы через родительские каталоги запрещены:

```text
/users/1.json
C:/users/1.json
C:users/1.json
users/../1.json
```

## Compaction

MTDB использует append-only журнал.

При повторных изменениях одного документа старые версии продолжают физически находиться в `.mtdb` файле.

Например:

```js
db.write('users/1.json', {
  city: 'Kharkiv'
});

db.write('users/1.json', {
  city: 'Stara Zagora'
});
```

Для удаления устаревшей истории можно выполнить:

```js
const result = db.compact();

console.log(result);
```

Пример результата:

```js
{
  beforeSize: 106723328,
  afterSize: 22512947,
  reclaimedBytes: 84210381,
  scannedRecords: 412455,
  writtenRecords: 76195,
  files: 75938,
  directories: 257,
  deleted: 24062,
  historical: 312198
}
```

`compact()`:

* сохраняет актуальные JSON;
* сохраняет актуальные каталоги;
* удаляет старые версии документов;
* удаляет tombstone;
* перестраивает hash index;
* проверяет новый файл перед заменой основной базы.

Операция полностью синхронная.

## Закрытие базы

После завершения работы базу необходимо закрыть:

```js
db.close();
```

Первый успешный вызов возвращает:

```js
true
```

Повторный:

```js
false
```

После `close()` экземпляр использовать нельзя.

```js
db.close();

db.read('settings.json');
```

завершится ошибкой:

```text
MTDB_CLOSED
```

## Crash recovery

MTDB использует журнал операций с отдельными `COMMIT`-записями.

Упрощённо запись выглядит так:

```text
DIRTY

WRITE
COMMIT
fsync

update index
fsync
```

Если процесс аварийно завершится во время записи, при следующем `open()` MTDB восстанавливает индекс из подтверждённых операций.

Незавершённый хвост журнала отбрасывается.

Подтверждённые повреждённые данные при этом не игнорируются молча — MTDB возвращает ошибку повреждения.

Пример обычного восстановления:

```js
const db = mtdb.open('./data.mtdb');
```

Если предыдущий процесс завершился некорректно и база осталась в состоянии `DIRTY`, необходимый recovery выполняется автоматически во время открытия.

## Single writer

Один `.mtdb` файл может быть открыт только одним writer-процессом одновременно.

```js
const first = mtdb.open('./data.mtdb');
const second = mtdb.open('./data.mtdb');
```

Второй вызов завершится:

```text
MTDB_ALREADY_OPEN
```

MTDB также защищается от обхода writer-lock через symbolic link и hard link.

После аварийного завершения процесса stale writer-lock может быть восстановлен автоматически при следующем открытии базы.

## Обработка ошибок

Все ошибки MTDB являются обычными объектами `Error`.

Для программной обработки необходимо использовать:

```js
error.code
```

Например:

```js
try {
  db.write('users/1.json', {
    name: 'Mlasuzin'
  });
}

catch (error) {
  if (error.code === 'MTDB_JSON_TOO_LARGE') {
    console.error('JSON слишком большой');
    return;
  }

  throw error;
}
```

Не рекомендуется использовать `error.message` как часть логики приложения — текст сообщения предназначен для диагностики.

### Recovery required

Если во время изменения базы произошла I/O-ошибка и MTDB больше не может гарантировать корректность текущего runtime-состояния, экземпляр переводится в состояние:

```text
MTDB_RECOVERY_REQUIRED
```

После этого необходимо закрыть базу и открыть её снова:

```js
try {
  db.write('users/1.json', user);
}

catch (error) {
  try {
    db.close();
  }

  catch {}

  throw error;
}
```

Затем:

```js
const db = mtdb.open('./data.mtdb');
```

Recovery при необходимости будет выполнен во время открытия.

## API

MTDB экспортирует:

```js
const mtdb = require('@mlasuzin/mtdb');

const db = mtdb.open(filePath);
```

Экземпляр базы предоставляет:

```js
db.mkdir(path);
db.list(path);
db.read(path);
db.write(path, value);
db.delete(path);
db.compact();
db.close();
```

Кратко:

| Метод                   | Назначение                      | Результат           |
| ----------------------- | ------------------------------- | ------------------- |
| `mtdb.open(path)`       | Открывает или создаёт базу      | `Database`          |
| `db.mkdir(path)`        | Создаёт каталог                 | `boolean`           |
| `db.list(path)`         | Возвращает JSON внутри каталога | `string[]`          |
| `db.read(path)`         | Читает JSON                     | value / `undefined` |
| `db.write(path, value)` | Создаёт или перезаписывает JSON | `true`              |
| `db.delete(path)`       | Удаляет JSON                    | `boolean`           |
| `db.compact()`          | Удаляет устаревшую историю      | `object`            |
| `db.close()`            | Закрывает базу                  | `boolean`           |

## Ограничения

Текущая версия MTDB:

* использует синхронный API;
* работает только с JSON;
* поддерживает одного writer на базу;
* не имеет read-only API;
* не имеет транзакций;
* не имеет SQL или query language;
* не имеет secondary indexes;
* не имеет `find()`;
* не имеет `exists()`;
* не имеет watchers;
* не поддерживает удаление каталогов;
* не выполняет автоматический `compact()`.

Максимальный размер одного сериализованного JSON:

```text
100 MiB
```

Максимальная длина внутреннего пути:

```text
1024 байта UTF-8
```

Текущая версия формата базы:

```text
2
```

## Формат хранения

Файл MTDB состоит из:

```text
+-----------------------------+
| Header                      |
| 4096 bytes                  |
+-----------------------------+
| Hash bucket index           |
| 65536 × 8 bytes             |
+-----------------------------+
| Append-only record journal  |
| variable size               |
+-----------------------------+
```

Для поиска документов используется 32-битный FNV-1a hash.

Коллизии разрешаются через цепочки записей внутри bucket.

Каждая запись защищена CRC32 checksum.

Hash index не является единственным источником истины: после аварийного завершения он может быть полностью восстановлен из подтверждённого журнала.

Подробнее устройство бинарного формата описано в:

```text
FORMAT.md
```

## Документация

Подробная документация находится в репозитории:

```text
API.md
ERRORS.md
FORMAT.md
CHANGELOG.md
```

* `API.md` — полный публичный API;
* `ERRORS.md` — ошибки и правила восстановления;
* `FORMAT.md` — бинарный формат `.mtdb`;
* `CHANGELOG.md` — история изменений.

## Требования

```text
Node.js >= 18
```

Runtime-зависимости отсутствуют.

## Лицензия

Apache-2.0
