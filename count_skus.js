require('dotenv').config(); const { Pool } = require('pg'); const pool = new Pool(); pool.query('SELECT COUNT(*) FROM skumapping;', (err, res) => { console.log(err ? err : res.rows); pool.end(); });
