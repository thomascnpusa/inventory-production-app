require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');

// Manually set the connection string
const connectionString = 'postgresql://localhost:5432/inventory_production_db';

console.log(`Using connection string: ${connectionString}`);

// Create a PostgreSQL connection pool
const pgPool = new Pool({
    connectionString: connectionString
});

async function testMmrSubsteps() {
    try {
        console.log("Testing MMR Substeps...");
        
        // Get all substeps for MMR product FG-2001, version 1
        const productSku = 'FG-2001';
        const version = 1;
        
        const result = await pgPool.query(`
            SELECT * FROM MMRSubSteps 
            WHERE mmr_product_sku = $1 
            AND mmr_version = $2 
            ORDER BY main_step_number, sub_step_number
        `, [productSku, version]);
        
        console.log(`Found ${result.rowCount} substeps for ${productSku}, version ${version}`);
        
        if (result.rowCount > 0) {
            // Group by main step number
            const stepGroups = {};
            
            result.rows.forEach(substep => {
                if (!stepGroups[substep.main_step_number]) {
                    stepGroups[substep.main_step_number] = [];
                }
                stepGroups[substep.main_step_number].push(substep);
            });
            
            console.log("Substeps by main step number:");
            
            Object.keys(stepGroups).forEach(stepNumber => {
                console.log(`\nStep ${stepNumber} has ${stepGroups[stepNumber].length} substeps:`);
                stepGroups[stepNumber].forEach(substep => {
                    console.log(`  ${substep.sub_step_number || 'N/A'}: ${substep.description.substring(0, 50)}... (Type: ${substep.step_type})`);
                });
            });
        } else {
            console.log("No substeps found.");
        }
        
        // Get production steps for order #62
        const orderResult = await pgPool.query(`
            SELECT * FROM ProductionSteps 
            WHERE production_order_id = 62 
            ORDER BY step_number
        `);
        
        console.log(`\nFound ${orderResult.rowCount} production steps for order #62`);
        
        if (orderResult.rowCount > 0) {
            orderResult.rows.forEach(step => {
                console.log(`Step ${step.step_number}: ${step.description.substring(0, 50)}...`);
                
                // Check if there are matching substeps
                const matchingStepNumber = step.step_number;
                const matchingSubsteps = result.rows.filter(
                    substep => Number(substep.main_step_number) === Number(matchingStepNumber)
                );
                
                console.log(`  ${matchingSubsteps.length} matching substeps found`);
            });
        }
        
    } catch (error) {
        console.error("Error testing MMR substeps:", error);
    } finally {
        pgPool.end();
    }
}

testMmrSubsteps(); 