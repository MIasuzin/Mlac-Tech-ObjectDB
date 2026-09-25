> **Машинен превод:** Този README е преведен автоматично от оригиналната руска версия.

# JSON с удобството и надеждността на база данни

`Mlac Tech ObjectDB` помага за съхранение на данните на малки Node.js приложения, когато поддръжката на отделни JSON файлове вече е неудобна. Данните се намират в един `.mtdb` файл, но в кода изглеждат като JSON документи в папки: могат да се четат, записват и променят заедно в транзакции.

Библиотеката работи без отделен сървър, автоматично възстановява потвърдените записи след срив, проверява целостта на данните и премахва остарелите записи. Достатъчно е да отворите базата и да работите с документите.

![Mlac-Tech ObjectDB](imgs/banner.png)
[Русский](README.md) · [English](docs/README.en.md) · [فارسی](docs/README.fa.md) · [简体中文](docs/README.zh-CN.md) · [Български](docs/README.bg.md)

## Възможности

* Един файл на базата данни `.mtdb`
* Прост синхронен API
* Съхранение на обикновени JSON данни
* Виртуални директории вътре в базата
* Append-only журнал на промените
* Надежден запис чрез `RECORD + COMMIT + fsync`
* Автоматично възстановяване след аварийно прекратяване
* CRC32 проверка на целостта на всеки запис
* Възстановим hash индекс с 65 536 buckets
* Автоматично възстановяване на повреден индекс от журнала
* Защита от едновременно записване от няколко процеса
* Автоматично възстановяване на остарял writer-lock
* Защита на writer-lock от състезания между процеси
* Защита от заобикаляне на заключването чрез symbolic link и hard link
* Безопасно създаване на нова база чрез временен файл
* Компактизация с премахване на стари версии и tombstone записи
* Проверка на новия файл преди завършване на компактизацията
* Явни кодове за грешки за програмна обработка
* Без runtime зависимости
* CommonJS API

## Основни методи на библиотеката

```js
const mtdb = require('@mlasuzin/mtdb');

const db = mtdb.open('./data.mtdb');
```

Публичен API на базата:

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

Отваря съществуваща база или създава нова.

```js
const db = mtdb.open('./data.mtdb');
```

Пътят трябва да завършва на `.mtdb`.

При отваряне MTDB получава ексклузивен writer-lock, затова един файл на базата може да се използва само от един writer процес едновременно.

След некоректно прекратяване на предишния процес необходимото възстановяване се извършва автоматично при следващото отваряне.

Връща инстанция на базата.

---

### `db.mkdir(path)`

Създава виртуална директория или наведнъж цялата липсваща верига от директории.

```js
db.mkdir('users');
db.mkdir('users/archive/old');
```

Връща `true`, ако е създадена поне една директория, и `false`, ако цялата верига вече е съществувала.

Кореновата директория съществува автоматично и не е необходимо да се създава.

---

### `db.rmdir(path)`

Изтрива виртуална директория вътре в базата.

```js
db.rmdir('users/archive/old');
db.rmdir('users/archive');
```

Връща `true`, ако директорията е съществувала и е изтрита, и `false`, ако директорията не съществува.

Изтрива се само посочената директория. Кореновата директория не може да бъде изтрита.

---

### `db.has(path)`

Проверява дали JSON документ съществува, без да чете и парсва съдържанието му.

```js
db.has('users/1.json');
```

Връща `true`, ако документът съществува, и `false`, ако документът липсва или е бил изтрит.

За разлика от `read()`, методът не изпълнява `JSON.parse()` и е подходящ за бърза проверка дали данните съществуват.

---

### `db.list(path, options)`

Връща сортиран списък с JSON документи в директория.

```js
db.list('users');
```

По подразбиране търсенето не е рекурсивно:

```js
[
  'users/1.json',
  'users/2.json'
]
```

За получаване на документи от всички вложени директории:

```js
db.list('users', {
  recursive: true
});
```

Кореновата директория се обозначава с празен низ:

```js
db.list('');
```

Методът връща `string[]`.

---

### `db.read(path)`

Чете JSON документ и връща записаната JavaScript стойност.

```js
const user = db.read('users/1.json');
```

Ако документът липсва или е бил изтрит:

```js
undefined
```

JSON се парсва автоматично чрез `JSON.parse()`.

---

### `db.write(path, value)`

Създава нов JSON документ или заменя съществуващ.

```js
db.write('users/1.json', {
  id: 1,
  name: 'Mlasuzin'
});
```

Стойността се сериализира чрез `JSON.stringify()`.

За вложен документ родителската директория трябва да съществува:

```js
db.mkdir('users');

db.write('users/1.json', {
  id: 1
});
```

Пътят на документа трябва да завършва на `.json`.

Максималният размер на сериализирания JSON е `100 MiB`.

След успешен запис връща `true`.

---

### `db.delete(path)`

Изтрива JSON документ.

```js
db.delete('users/1.json');
```

Връща:

* `true` — документът е съществувал и е изтрит;
* `false` — документът липсва или вече е бил изтрит.

След изтриване `db.read(path)` връща `undefined`.

---

### `db.transaction(handler)`

Изпълнява няколко промени като една атомарна операция.

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

Вътре в транзакцията са достъпни:

```js
tx.read(path);
tx.write(path, value);
tx.delete(path);
```

`tx.read()` вижда промените, които вече са направени в същата транзакция.

Промените се потвърждават само след успешно завършване на callback. Ако callback хвърли грешка, транзакцията не се записва.

Callback трябва да е синхронен. `async` функции и `Promise` не се поддържат. Вложени транзакции също не са позволени.

`db.transaction()` връща стойността, върната от callback:

```js
const result = db.transaction((tx) => {
  tx.write('settings.json', {
    enabled: true
  });

  return 'saved';
});

console.log(result); // saved
```

Една транзакция може да съдържа до `1000` променяни пътя и до `128 MiB` подготвени данни.

---

### `db.verify()`

Извършва пълна проверка на целостта на базата.

```js
const result = db.verify();
```

Проверяват се структурата на файла, metadata, журналът, записите, checksums, транзакциите и съответствието на hash индекса с потвърдените данни.

При коректна база се връща обект:

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

Ако бъде открита повреда или несъответствие, методът хвърля съответната MTDB грешка.

`verify()` извършва пълна синхронна проверка на файла и може да бъде скъпа операция за голяма база.

---

### `db.stats()`

Връща статистика за текущото състояние на базата.

```js
const stats = db.stats();
```

Резултат:

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

Основни стойности:

* `fileSize` — физически размер на `.mtdb` файла;
* `files` — брой актуални JSON документи;
* `directories` — брой директории;
* `liveRecords` — брой актуални записи;
* `garbageRecords` — брой остарели записи;
* `liveBytes` — обем на актуалните данни;
* `garbageBytes` — обем на остарелите данни;
* `garbageRatio` — дял на остарелите данни във файла.

За да получи статистиката, MTDB също проверява целостта на базата, затова `stats()` е синхронна операция с пълно обхождане на журнала.

---

### `db.close()`

Затваря коректно базата и освобождава writer-lock.

```js
db.close();
```

Първото успешно извикване връща:

```js
true
```

Повторно извикване:

```js
false
```

След затваряне инстанцията на базата не може да се използва.

---

### Кратък справочник

| Метод | Предназначение | Резултат |
| --- | --- | --- |
| `mtdb.open(filePath)` | Отваря или създава база | `Database` |
| `db.mkdir(path)` | Създава директория или верига от директории | `boolean` |
| `db.list(path, options)` | Връща JSON документи в директория | `string[]` |
| `db.read(path)` | Чете JSON документ | value / `undefined` |
| `db.write(path, value)` | Създава или презаписва JSON | `true` |
| `db.delete(path)` | Изтрива JSON документ | `boolean` |
| `db.transaction(handler)` | Атомарно изпълнява група промени | резултатът от `handler` |
| `db.verify()` | Проверява целостта на базата | `object` |
| `db.stats()` | Връща статистика за базата | `object` |
| `db.close()` | Затваря базата и освобождава writer-lock | `boolean` |

Компактизацията не е част от публичния API. MTDB я изпълнява автоматично вътре в библиотеката, когато е необходимо.

## Пример за използване

Може да се използва като локално хранилище за състоянието на малък Node.js сървис.

В този пример базата съхранява потребители, техните настройки и активни сесии.

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

Тук MTDB се използва като обикновено вградено хранилище на приложението без отделен сървър за база данни и без ръчно управление на набор от JSON файлове.

## Документация

Подробната документация се намира в хранилището:

```text
API.md
ERRORS.md
FORMAT.md
CHANGELOG.md
```

* `API.md` — пълният публичен API;
* `ERRORS.md` — грешки и правила за възстановяване;
* `FORMAT.md` — бинарният формат `.mtdb`;
* `CHANGELOG.md` — история на промените.

## Изисквания

```text
Node.js >= 18
```

Няма runtime зависимости.

## Лиценз

Apache-2.0
