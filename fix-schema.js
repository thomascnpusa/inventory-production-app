const { Pool } = require('pg');
require('dotenv').config();

const pgPool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT
});

const run = async () => {
    const client = await pgPool.connect();
    try {
        console.log("Adding missing columns to ProductionOrders table...");
        
        // Check if the columns already exist
        const columnCheckResult = await client.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'productionorders' 
            AND column_name = 'completed_at'
        `);
        
        if (columnCheckResult.rows.length === 0) {
            console.log("Column 'completed_at' does not exist, adding it...");
            await client.query(`
                ALTER TABLE ProductionOrders 
                ADD COLUMN completed_at TIMESTAMP
            `);
            console.log("Column added successfully!");
        } else {
            console.log("Column 'completed_at' already exists, skipping...");
        }
        
        console.log("Checking ProductionSteps table structure...");
        
        // Fetch a sample step to check
        const stepResult = await client.query(`
            SELECT * FROM ProductionSteps 
            WHERE production_order_id = 16 
            LIMIT 1
        `);
        
        if (stepResult.rows.length > 0) {
            console.log("Found step:", stepResult.rows[0]);
        } else {
            console.log("No steps found for order 16");
        }
        
    } catch (err) {
        console.error("Error updating schema:", err);
    } finally {
        client.release();
        process.exit(0);
    }
};

run(); 