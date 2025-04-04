const { Pool } = require('pg');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Create a new pool using the same configuration as your main app
const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    port: process.env.PG_PORT
});

const createTableSQL = `
-- Production Order Test Reports table
CREATE TABLE IF NOT EXISTS ProductionOrderTestReports (
    id SERIAL PRIMARY KEY,
    production_order_id INTEGER NOT NULL REFERENCES ProductionOrders(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,         -- The name of the file as stored on the server (could be sanitized/unique)
    original_filename VARCHAR(255) NOT NULL, -- The original name of the uploaded file
    file_path VARCHAR(512) NOT NULL UNIQUE,  -- The path where the file is stored on the server's filesystem
    mime_type VARCHAR(50) DEFAULT 'application/pdf',
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    uploaded_by_user_id INTEGER REFERENCES Users(id) -- Optional: track who uploaded
);

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_prod_test_reports_order_id ON ProductionOrderTestReports(production_order_id);
CREATE INDEX IF NOT EXISTS idx_prod_test_reports_filename ON ProductionOrderTestReports(filename);
`;

async function createTable() {
    try {
        console.log('Creating ProductionOrderTestReports table...');
        await pool.query(createTableSQL);
        console.log('Table created successfully!');
    } catch (err) {
        console.error('Error creating table:', err);
    } finally {
        await pool.end();
    }
}

createTable(); 