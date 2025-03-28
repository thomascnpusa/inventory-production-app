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
        console.log("Checking MMR for product_sku ING-001 version 1...");
        const mmrResult = await client.query(
            "SELECT * FROM MMRs WHERE product_sku = 'ING-001' AND version = 1"
        );
        
        if (mmrResult.rows.length === 0) {
            console.log("MMR not found, cannot proceed");
            return;
        }
        
        console.log("Found MMR:", mmrResult.rows[0]);
        
        // Begin transaction
        await client.query('BEGIN');
        
        // Create inventory items for ingredients if they don't exist
        const sampleIngredients = [
            { sku: 'RAW-201', name: 'Ingredient A', quantity: 50, unit_type: 'g' },
            { sku: 'RAW-345', name: 'Ingredient B', quantity: 25, unit_type: 'ml' },
            { sku: 'RAW-100', name: 'Ingredient C', quantity: 10, unit_type: 'g' }
        ];
        
        console.log("Creating inventory items for ingredients...");
        for (const ingredient of sampleIngredients) {
            // Check if inventory item exists
            const itemResult = await client.query(
                "SELECT * FROM InventoryItems WHERE sku = $1",
                [ingredient.sku]
            );
            
            if (itemResult.rows.length === 0) {
                // Create inventory item
                await client.query(
                    `INSERT INTO InventoryItems 
                    (sku, name, type, stock_level, min_level, unit_type, location) 
                    VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [
                        ingredient.sku,
                        ingredient.name,
                        'raw ingredient',
                        100, // Default stock level
                        10,  // Default min level
                        ingredient.unit_type,
                        'Warehouse'
                    ]
                );
                console.log(`Created inventory item for ${ingredient.sku}`);
            } else {
                console.log(`Inventory item for ${ingredient.sku} already exists`);
            }
        }
        
        // Clear existing ingredients
        console.log("Clearing existing ingredients...");
        await client.query(
            "DELETE FROM MMRIngredients WHERE mmr_product_sku = 'ING-001' AND mmr_version = 1"
        );
        
        // Add new ingredients
        console.log("Adding sample ingredients...");
        for (const ingredient of sampleIngredients) {
            await client.query(
                `INSERT INTO MMRIngredients 
                (mmr_product_sku, mmr_version, ingredient_sku, quantity, unit_type) 
                VALUES ('ING-001', 1, $1, $2, $3)`,
                [ingredient.sku, ingredient.quantity, ingredient.unit_type]
            );
            console.log(`Added ingredient ${ingredient.sku}`);
        }
        
        // Add sample equipment
        const sampleEquipment = [
            { equipment_name: 'Mixing bowl' },
            { equipment_name: 'Digital scale' },
            { equipment_name: 'Heating element' }
        ];
        
        // Clear existing equipment
        console.log("Clearing existing equipment...");
        await client.query(
            "DELETE FROM MMREquipment WHERE mmr_product_sku = 'ING-001' AND mmr_version = 1"
        );
        
        // Add new equipment
        console.log("Adding sample equipment...");
        for (const equipment of sampleEquipment) {
            await client.query(
                `INSERT INTO MMREquipment 
                (mmr_product_sku, mmr_version, equipment_name) 
                VALUES ('ING-001', 1, $1)`,
                [equipment.equipment_name]
            );
            console.log(`Added equipment ${equipment.equipment_name}`);
        }
        
        // Add sample steps
        const sampleSteps = [
            { step_number: 1, description: 'Weigh out all dry ingredients accurately' },
            { step_number: 2, description: 'Measure all liquid components' },
            { step_number: 3, description: 'Mix dry ingredients together thoroughly' },
            { step_number: 4, description: 'Slowly add liquid components while stirring' },
            { step_number: 5, description: 'Heat mixture to 65°C and maintain for 10 minutes' },
            { step_number: 6, description: 'Cool to room temperature before proceeding' }
        ];
        
        // Clear existing steps
        console.log("Clearing existing steps...");
        await client.query(
            "DELETE FROM MMRSteps WHERE mmr_product_sku = 'ING-001' AND mmr_version = 1"
        );
        
        // Add new steps
        console.log("Adding sample steps...");
        for (const step of sampleSteps) {
            await client.query(
                `INSERT INTO MMRSteps 
                (mmr_product_sku, mmr_version, step_number, description) 
                VALUES ('ING-001', 1, $1, $2)`,
                [step.step_number, step.description]
            );
            console.log(`Added step ${step.step_number}: ${step.description}`);
        }
        
        // Commit changes
        await client.query('COMMIT');
        console.log("All sample MMR data committed successfully");
        
        // Now delete existing production steps for order 15
        console.log("Deleting existing production steps for order 15...");
        await client.query("DELETE FROM ProductionSteps WHERE production_order_id = 15");
        console.log("Production steps for order 15 deleted");
        
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error:", err);
    } finally {
        client.release();
        process.exit(0);
    }
};

run(); 