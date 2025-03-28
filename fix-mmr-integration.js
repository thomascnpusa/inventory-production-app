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
        // Get production order details including MMR info
        console.log("Fetching production order #15 details...");
        const orderResult = await client.query(`
            SELECT po.*, m.* 
            FROM ProductionOrders po
            LEFT JOIN MMRs m ON po.mmr_product_sku = m.product_sku AND po.mmr_version = m.version
            WHERE po.id = 15
        `);
        
        if (orderResult.rows.length === 0) {
            console.log("Order 15 not found!");
            return;
        }
        
        const order = orderResult.rows[0];
        console.log("Order 15 found:", {
            id: order.id,
            product_sku: order.product_sku,
            mmr_product_sku: order.mmr_product_sku,
            mmr_version: order.mmr_version,
            quantity: order.quantity,
            base_quantity: order.base_quantity
        });
        
        // Fetch MMR ingredients
        console.log("Fetching MMR ingredients...");
        const ingredientsResult = await client.query(`
            SELECT * FROM MMRIngredients 
            WHERE mmr_product_sku = $1 AND mmr_version = $2
        `, [order.mmr_product_sku, order.mmr_version]);
        
        console.log(`Found ${ingredientsResult.rows.length} ingredients`);
        
        // Fetch MMR equipment
        console.log("Fetching MMR equipment...");
        const equipmentResult = await client.query(`
            SELECT * FROM MMREquipment 
            WHERE mmr_product_sku = $1 AND mmr_version = $2
        `, [order.mmr_product_sku, order.mmr_version]);
        
        console.log(`Found ${equipmentResult.rows.length} equipment items`);
        
        // Fetch MMR steps
        console.log("Fetching MMR steps...");
        const mmrStepsResult = await client.query(`
            SELECT * FROM MMRSteps 
            WHERE mmr_product_sku = $1 AND mmr_version = $2
            ORDER BY step_number
        `, [order.mmr_product_sku, order.mmr_version]);
        
        console.log(`Found ${mmrStepsResult.rows.length} MMR steps`);
        
        // Fetch current production steps
        console.log("Fetching current production steps...");
        const prodStepsResult = await client.query(`
            SELECT * FROM ProductionSteps 
            WHERE production_order_id = 15
            ORDER BY step_number
        `);
        
        console.log(`Found ${prodStepsResult.rows.length} production steps`);
        
        // Delete existing production steps
        if (prodStepsResult.rows.length > 0) {
            console.log("Deleting existing production steps...");
            await client.query(`
                DELETE FROM ProductionSteps 
                WHERE production_order_id = 15
            `);
            console.log("Existing steps deleted");
        }
        
        // Create structured steps based on MMR data
        console.log("Creating new production steps with MMR data...");
        
        // Create ingredients step with ingredient details
        const ingredients = ingredientsResult.rows;
        if (ingredients.length > 0) {
            const ingredientList = ingredients.map(ing => 
                `${ing.ingredient_sku}: ${ing.quantity} ${ing.unit_type}`
            ).join(', ');
            
            await client.query(`
                INSERT INTO ProductionSteps 
                (production_order_id, step_number, description, quality_checks) 
                VALUES (15, 1, $1, '[]')
            `, [`Gather all required ingredients: ${ingredientList}`]);
            
            console.log("Created ingredients step");
        } else {
            await client.query(`
                INSERT INTO ProductionSteps 
                (production_order_id, step_number, description, quality_checks) 
                VALUES (15, 1, 'Gather all required ingredients', '[]')
            `);
        }
        
        // Create equipment step with equipment details
        const equipment = equipmentResult.rows;
        if (equipment.length > 0) {
            const equipmentList = equipment.map(eq => eq.equipment_name).join(', ');
            
            await client.query(`
                INSERT INTO ProductionSteps 
                (production_order_id, step_number, description, quality_checks) 
                VALUES (15, 2, $1, '[]')
            `, [`Prepare all required equipment: ${equipmentList}`]);
            
            console.log("Created equipment step");
        } else {
            await client.query(`
                INSERT INTO ProductionSteps 
                (production_order_id, step_number, description, quality_checks) 
                VALUES (15, 2, 'Prepare all required equipment', '[]')
            `);
        }
        
        // Create manufacturing steps from MMR steps
        let stepNum = 3;
        const mmrSteps = mmrStepsResult.rows;
        if (mmrSteps.length > 0) {
            for (const step of mmrSteps) {
                await client.query(`
                    INSERT INTO ProductionSteps 
                    (production_order_id, step_number, description, quality_checks) 
                    VALUES (15, $1, $2, '[]')
                `, [stepNum, step.description]);
                
                console.log(`Created manufacturing step ${stepNum}: ${step.description}`);
                stepNum++;
            }
        } else {
            await client.query(`
                INSERT INTO ProductionSteps 
                (production_order_id, step_number, description, quality_checks) 
                VALUES (15, 3, 'Execute manufacturing process according to MMR', '[]')
            `);
        }
        
        // Create packaging step
        await client.query(`
            INSERT INTO ProductionSteps 
            (production_order_id, step_number, description, quality_checks) 
            VALUES (15, $1, 'Package the finished product', '[]')
        `, [stepNum++]);
        
        // Create labeling step
        await client.query(`
            INSERT INTO ProductionSteps 
            (production_order_id, step_number, description, quality_checks) 
            VALUES (15, $1, 'Apply labels to packaged product', '[]')
        `, [stepNum]);
        
        console.log("All production steps created with MMR data");
        
    } catch (err) {
        console.error("Error:", err);
    } finally {
        client.release();
        process.exit(0);
    }
};

run(); 