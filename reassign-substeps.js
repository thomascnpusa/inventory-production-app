require('dotenv').config();
const { Pool } = require('pg');

// Create a PostgreSQL connection pool
const pgPool = new Pool({
    connectionString: 'postgresql://localhost:5432/inventory_production_db'
});

async function reassignSubsteps() {
    try {
        console.log("Reassigning MMR Substeps for FG-2001...");
        
        // Move substeps from step 1 to step 3
        const step1Result = await pgPool.query(`
            UPDATE MMRSubSteps 
            SET main_step_number = 3
            WHERE mmr_product_sku = 'FG-2001' 
            AND mmr_version = 1 
            AND main_step_number = 1
            RETURNING id, sub_step_number, description, main_step_number
        `);
        
        console.log(`Moved ${step1Result.rowCount} substeps from step 1 to step 3`);
        
        // Move substeps from step 2 to step 4
        const step2Result = await pgPool.query(`
            UPDATE MMRSubSteps 
            SET main_step_number = 4
            WHERE mmr_product_sku = 'FG-2001' 
            AND mmr_version = 1 
            AND main_step_number = 2
            RETURNING id, sub_step_number, description, main_step_number
        `);
        
        console.log(`Moved ${step2Result.rowCount} substeps from step 2 to step 4`);
        
        // Verify the changes
        const checkResult = await pgPool.query(`
            SELECT main_step_number, COUNT(*) as count
            FROM MMRSubSteps
            WHERE mmr_product_sku = 'FG-2001' AND mmr_version = 1
            GROUP BY main_step_number
            ORDER BY main_step_number
        `);
        
        console.log("Current substep distribution:");
        checkResult.rows.forEach(row => {
            console.log(`Step ${row.main_step_number}: ${row.count} substeps`);
        });
        
    } catch (error) {
        console.error("Error reassigning MMR substeps:", error);
    } finally {
        pgPool.end();
    }
}

reassignSubsteps(); 