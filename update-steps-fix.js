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
        console.log("Checking for step ID 18...");
        
        // Check if step 18 exists
        const stepResult = await client.query(
            "SELECT * FROM ProductionSteps WHERE id = 18"
        );
        
        if (stepResult.rows.length > 0) {
            console.log("Found step 18:", stepResult.rows[0]);
            
            // Manually update the step to be completed
            await client.query(
                `UPDATE ProductionSteps 
                SET completed = true,
                    completed_by = 'SYS',
                    completed_at = CURRENT_TIMESTAMP,
                    notes = 'Manually completed by system fix'
                WHERE id = 18`
            );
            
            console.log("Step 18 marked as completed");
        } else {
            console.log("Step ID 18 not found");
        }
        
        console.log("Checking for remaining steps for production order 16...");
        const remainingStepsResult = await client.query(
            "SELECT * FROM ProductionSteps WHERE production_order_id = 16 AND (completed = false OR completed IS NULL)"
        );
        
        if (remainingStepsResult.rows.length > 0) {
            console.log(`Found ${remainingStepsResult.rows.length} incomplete steps for order 16`);
            console.log("Step IDs:", remainingStepsResult.rows.map(row => row.id).join(", "));
        } else {
            console.log("All steps for order 16 are completed");
            
            // If all steps are completed, update the production order status
            await client.query(
                `UPDATE ProductionOrders 
                SET status = 'Completed' 
                WHERE id = 16`
            );
            
            console.log("Production order 16 marked as completed");
        }
        
    } catch (err) {
        console.error("Error updating steps:", err);
    } finally {
        client.release();
        process.exit(0);
    }
};

run(); 