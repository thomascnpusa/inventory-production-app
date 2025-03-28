const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
require('dotenv').config();

const pgPool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT
});

async function createAdminUser() {
    const username = process.argv[2];
    const email = process.argv[3];
    const password = process.argv[4];

    if (!username || !email || !password) {
        console.error('Usage: node create-admin.js <username> <email> <password>');
        process.exit(1);
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pgPool.query(
            'INSERT INTO Users (username, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, username, email, role',
            [username, email, hashedPassword, 'admin']
        );

        console.log('Admin user created successfully:', {
            id: result.rows[0].id,
            username: result.rows[0].username,
            email: result.rows[0].email,
            role: result.rows[0].role
        });
    } catch (error) {
        console.error('Error creating admin user:', error);
    } finally {
        await pgPool.end();
    }
}

createAdminUser(); 