const {migrateVersion2} = require('./lib/database.js');

if (process.argv.length !== 3) {
  console.error('Ошибка: укажи путь к файлу .mtdb');
  process.exitCode = 1;
}

else {
  try {
    const migrated = migrateVersion2(process.argv[2]);
    console.log(migrated ? 'Лог: миграция v2 → v3 завершена' : 'Лог: файл уже имеет формат v3');
  }

  catch (error) {
    console.error(`Ошибка: ${error.message}`);
    process.exitCode = 1;
  }
}