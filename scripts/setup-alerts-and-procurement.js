const { Pool } = require('pg');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

async function setupDatabase() {
    const pool = new Pool({
        user: process.env.PG_USER,
        host: process.env.PG_HOST,
        database: process.env.PG_DATABASE,
        password: process.env.PG_PASSWORD,
        port: process.env.PG_PORT
    });

    try {
        // Read the SQL file
        const sqlFile = path.join(__dirname, 'setup-alerts-and-procurement.sql');
        const sql = await fs.readFile(sqlFile, 'utf8');

        // Execute the SQL
        await pool.query(sql);
        console.log('Successfully set up alerts and procurement tables');

        // Create a sample supplier
        const sampleSupplier = {
            name: 'Sample Supplier',
            contact_info: 'John Doe',
            email: 'john@supplier.com',
            phone: '555-0123',
            address: '123 Supplier St, City, State 12345'
        };

        const supplierQuery = `
            INSERT INTO suppliers (name, contact_info, email, phone, address)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id
        `;

        const supplierResult = await pool.query(supplierQuery, [
            sampleSupplier.name,
            sampleSupplier.contact_info,
            sampleSupplier.email,
            sampleSupplier.phone,
            sampleSupplier.address
        ]);

        if (supplierResult.rows.length > 0) {
            console.log('Created sample supplier');
        }

    } catch (error) {
        console.error('Error setting up database:', error);
        throw error;
    } finally {
        await pool.end();
    }
}

// Run the setup
setupDatabase().catch(console.error); 