> **ترجمهٔ ماشینی:** این README به‌صورت خودکار از نسخهٔ اصلی روسی ترجمه شده است.

# راحتی JSON با قابلیت اطمینان یک پایگاه داده

`Mlac Tech ObjectDB` برای ذخیره‌سازی داده‌های برنامه‌های کوچک Node.js مناسب است، زمانی که نگهداری فایل‌های جداگانهٔ JSON دیگر راحت نیست. داده‌ها در یک فایل `.mtdb` قرار می‌گیرند، اما در کد مانند اسناد JSON داخل پوشه‌ها دیده می‌شوند: می‌توان آن‌ها را خواند، نوشت و در یک تراکنش به‌صورت گروهی تغییر داد.

این کتابخانه بدون سرور جداگانه کار می‌کند، رکوردهای commit‌شده را پس از خرابی به‌طور خودکار بازیابی می‌کند، یکپارچگی داده‌ها را بررسی می‌کند و رکوردهای منسوخ را حذف می‌کند. کافی است پایگاه داده را باز کنید و با اسناد کار کنید.

![Mlac-Tech ObjectDB](docs/imgs/banner.png)
[Русский](README.md) · [English](docs/README.en.md) · [فارسی](docs/README.fa.md) · [简体中文](docs/README.zh-CN.md) · [Български](docs/README.bg.md)

## قابلیت‌ها

* یک فایل پایگاه دادهٔ `.mtdb`
* API همگام و ساده
* ذخیره‌سازی داده‌های معمولی JSON
* دایرکتوری‌های مجازی داخل پایگاه داده
* ژورنال تغییرات append-only
* نوشتن پایدار با `RECORD + COMMIT + fsync`
* بازیابی خودکار پس از خاتمهٔ غیرمنتظره
* بررسی یکپارچگی CRC32 برای هر رکورد
* hash-index قابل بازسازی با 65,536 bucket
* بازیابی خودکار index آسیب‌دیده از روی journal
* محافظت در برابر نوشتن هم‌زمان چند process
* بازیابی خودکار writer-lock منقضی‌شده
* محافظت از writer-lock در برابر race بین processها
* محافظت در برابر دور زدن lock با symbolic link و hard link
* ساخت امن پایگاه دادهٔ جدید از طریق فایل موقت
* compaction همراه با حذف نسخه‌های قدیمی و رکوردهای tombstone
* بررسی فایل جدید پیش از تکمیل compaction
* کدهای خطای مشخص برای پردازش برنامه‌ای
* بدون وابستگی runtime
* CommonJS API

## متدهای اصلی کتابخانه

```js
const mtdb = require('@mlasuzin/mtdb');

const db = mtdb.open('./data.mtdb');
```

API عمومی پایگاه داده:

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

یک پایگاه دادهٔ موجود را باز می‌کند یا یک پایگاه دادهٔ جدید می‌سازد.

```js
const db = mtdb.open('./data.mtdb');
```

مسیر باید به `.mtdb` ختم شود.

هنگام باز شدن، MTDB یک writer-lock انحصاری می‌گیرد؛ بنابراین هر فایل پایگاه داده در هر لحظه فقط می‌تواند توسط یک writer process استفاده شود.

اگر process قبلی به‌صورت غیرعادی متوقف شده باشد، بازیابی لازم در باز شدن بعدی پایگاه داده به‌طور خودکار انجام می‌شود.

یک نمونه از پایگاه داده را برمی‌گرداند.

---

### `db.mkdir(path)`

یک دایرکتوری مجازی یا کل زنجیرهٔ دایرکتوری‌های موجودنبوده را ایجاد می‌کند.

```js
db.mkdir('users');
db.mkdir('users/archive/old');
```

اگر حداقل یک دایرکتوری ساخته شود `true` و اگر کل زنجیره از قبل وجود داشته باشد `false` برمی‌گرداند.

دایرکتوری ریشه به‌صورت خودکار وجود دارد و نیازی به ساختن آن نیست.

---

### `db.rmdir(path)`

یک دایرکتوری مجازی را از داخل پایگاه داده حذف می‌کند.

```js
db.rmdir('users/archive/old');
db.rmdir('users/archive');
```

اگر دایرکتوری وجود داشته و حذف شود `true` و اگر وجود نداشته باشد `false` برمی‌گرداند.

فقط دایرکتوری مشخص‌شده حذف می‌شود. دایرکتوری ریشه قابل حذف نیست.

---

### `db.has(path)`

وجود یک سند JSON را بدون خواندن و parse کردن محتوای آن بررسی می‌کند.

```js
db.has('users/1.json');
```

اگر سند وجود داشته باشد `true` و اگر وجود نداشته باشد یا حذف شده باشد `false` برمی‌گرداند.

برخلاف `read()`، این متد `JSON.parse()` را اجرا نمی‌کند و برای بررسی سریع وجود داده مناسب است.

---

### `db.list(path, options)`

فهرستی مرتب‌شده از اسناد JSON داخل یک دایرکتوری برمی‌گرداند.

```js
db.list('users');
```

به‌صورت پیش‌فرض جست‌وجو recursive نیست:

```js
[
  'users/1.json',
  'users/2.json'
]
```

برای دریافت اسناد از تمام دایرکتوری‌های تو در تو:

```js
db.list('users', {
  recursive: true
});
```

دایرکتوری ریشه با رشتهٔ خالی مشخص می‌شود:

```js
db.list('');
```

این متد `string[]` برمی‌گرداند.

---

### `db.read(path)`

یک سند JSON را می‌خواند و مقدار JavaScript ذخیره‌شده را برمی‌گرداند.

```js
const user = db.read('users/1.json');
```

اگر سند وجود نداشته باشد یا حذف شده باشد:

```js
undefined
```

JSON به‌صورت خودکار با `JSON.parse()` پردازش می‌شود.

---

### `db.write(path, value)`

یک سند JSON جدید می‌سازد یا سند موجود را جایگزین می‌کند.

```js
db.write('users/1.json', {
  id: 1,
  name: 'Mlasuzin'
});
```

مقدار با `JSON.stringify()` serialize می‌شود.

برای یک سند تو در تو، دایرکتوری والد باید از قبل وجود داشته باشد:

```js
db.mkdir('users');

db.write('users/1.json', {
  id: 1
});
```

مسیر سند باید به `.json` ختم شود.

حداکثر اندازهٔ JSON سریال‌شده `100 MiB` است.

پس از نوشتن موفق، `true` برمی‌گرداند.

---

### `db.delete(path)`

یک سند JSON را حذف می‌کند.

```js
db.delete('users/1.json');
```

مقدار بازگشتی:

* `true` — سند وجود داشته و حذف شده است؛
* `false` — سند وجود ندارد یا قبلاً حذف شده است.

پس از حذف، `db.read(path)` مقدار `undefined` برمی‌گرداند.

---

### `db.transaction(handler)`

چند تغییر را به‌عنوان یک عملیات atomic اجرا می‌کند.

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

داخل تراکنش متدهای زیر در دسترس هستند:

```js
tx.read(path);
tx.write(path, value);
tx.delete(path);
```

`tx.read()` تغییراتی را که در همان تراکنش انجام شده‌اند می‌بیند.

تغییرات فقط پس از پایان موفق callback ثبت می‌شوند. اگر callback خطا ایجاد کند، تراکنش نوشته نمی‌شود.

Callback باید همگام باشد. تابع‌های `async` و `Promise` پشتیبانی نمی‌شوند. تراکنش‌های تو در تو نیز مجاز نیستند.

`db.transaction()` مقداری را که callback برگردانده است برمی‌گرداند:

```js
const result = db.transaction((tx) => {
  tx.write('settings.json', {
    enabled: true
  });

  return 'saved';
});

console.log(result); // saved
```

هر تراکنش می‌تواند حداکثر `1000` مسیر تغییرکرده و حداکثر `128 MiB` دادهٔ آماده‌شده داشته باشد.

---

### `db.verify()`

یکپارچگی پایگاه داده را به‌طور کامل بررسی می‌کند.

```js
const result = db.verify();
```

ساختار فایل، metadata، journal، رکوردها، checksums، تراکنش‌ها و تطابق hash-index با داده‌های commit‌شده بررسی می‌شوند.

اگر پایگاه داده سالم باشد، یک object برگردانده می‌شود:

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

اگر خرابی یا ناسازگاری شناسایی شود، متد خطای متناظر MTDB را throw می‌کند.

`verify()` یک بررسی کامل و همگام روی فایل انجام می‌دهد و برای پایگاه داده‌های بزرگ می‌تواند عملیات پرهزینه‌ای باشد.

---

### `db.stats()`

آمار وضعیت فعلی پایگاه داده را برمی‌گرداند.

```js
const stats = db.stats();
```

نتیجه:

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

مقادیر اصلی:

* `fileSize` — اندازهٔ فیزیکی فایل `.mtdb`؛
* `files` — تعداد اسناد JSON فعلی؛
* `directories` — تعداد دایرکتوری‌ها؛
* `liveRecords` — تعداد رکوردهای فعلی؛
* `garbageRecords` — تعداد رکوردهای منسوخ؛
* `liveBytes` — حجم داده‌های فعلی؛
* `garbageBytes` — حجم داده‌های منسوخ؛
* `garbageRatio` — سهم داده‌های منسوخ در فایل.

برای دریافت آمار، MTDB یکپارچگی پایگاه داده را نیز بررسی می‌کند؛ بنابراین `stats()` یک عملیات همگام با پیمایش کامل journal است.

---

### `db.close()`

پایگاه داده را به‌درستی می‌بندد و writer-lock را آزاد می‌کند.

```js
db.close();
```

اولین فراخوانی موفق برمی‌گرداند:

```js
true
```

فراخوانی بعدی:

```js
false
```

پس از بسته شدن، دیگر نمی‌توان از نمونهٔ پایگاه داده استفاده کرد.

---

### مرجع سریع

| متد | کاربرد | نتیجه |
| --- | --- | --- |
| `mtdb.open(filePath)` | باز کردن یا ساخت پایگاه داده | `Database` |
| `db.mkdir(path)` | ساخت یک دایرکتوری یا زنجیره‌ای از دایرکتوری‌ها | `boolean` |
| `db.list(path, options)` | برگرداندن JSONهای داخل دایرکتوری | `string[]` |
| `db.read(path)` | خواندن سند JSON | value / `undefined` |
| `db.write(path, value)` | ساخت یا بازنویسی JSON | `true` |
| `db.delete(path)` | حذف سند JSON | `boolean` |
| `db.transaction(handler)` | اجرای atomic یک گروه از تغییرات | نتیجهٔ `handler` |
| `db.verify()` | بررسی یکپارچگی پایگاه داده | `object` |
| `db.stats()` | برگرداندن آمار پایگاه داده | `object` |
| `db.close()` | بستن پایگاه داده و آزاد کردن writer-lock | `boolean` |

Compaction بخشی از API عمومی نیست. MTDB در صورت نیاز آن را به‌طور خودکار در داخل کتابخانه انجام می‌دهد.

## نمونهٔ استفاده

می‌توان از MTDB به‌عنوان ذخیره‌ساز محلی وضعیت برای یک سرویس کوچک Node.js استفاده کرد.

در این مثال، پایگاه داده کاربران، تنظیمات آن‌ها و sessionهای فعال را ذخیره می‌کند.

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

در اینجا MTDB مانند یک ذخیره‌ساز embedded معمولی برای برنامه استفاده می‌شود؛ بدون سرور جداگانهٔ پایگاه داده و بدون مدیریت دستی مجموعه‌ای از فایل‌های JSON.

## مستندات

مستندات کامل‌تر در repository قرار دارند:

```text
API.md
ERRORS.md
FORMAT.md
CHANGELOG.md
```

* `API.md` — API عمومی کامل؛
* `ERRORS.md` — خطاها و قواعد بازیابی؛
* `FORMAT.md` — فرمت باینری `.mtdb`؛
* `CHANGELOG.md` — تاریخچهٔ تغییرات.

## نیازمندی‌ها

```text
Node.js >= 18
```

هیچ وابستگی runtime وجود ندارد.

## مجوز

Apache-2.0
