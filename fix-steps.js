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
        // Check if this order exists
        console.log("Checking if order 16 exists...");
        const orderResult = await client.query("SELECT * FROM ProductionOrders WHERE id = 16");
        
        if (orderResult.rows.length === 0) {
            console.log("Order 16 does not exist");
        } else {
            console.log("Order 16 exists:", orderResult.rows[0]);
            
            // Check if steps exist
            console.log("Checking if steps exist for order 16...");
            const stepsResult = await client.query("SELECT * FROM ProductionSteps WHERE production_order_id = 16");
            
            if (stepsResult.rows.length === 0) {
                console.log("No steps found, creating default step...");
                await client.query(
                    `INSERT INTO ProductionSteps 
                    (production_order_id, step_number, description, quality_checks) 
                    VALUES (16, 1, 'Complete production process', '[]')`
                );
                console.log("Default step created");
            } else {
                console.log("Steps found:", stepsResult.rows);
            }
        }
    } catch (err) {
        console.error("Error:", err);
    } finally {
        client.release();
        process.exit(0);
    }
};

run(); 