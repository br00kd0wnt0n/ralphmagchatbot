const { ensureDb, DB_PATH } = require('../services/store');

ensureDb();
console.log('DB ready at', DB_PATH);

