const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

async function addInventoryItems() {
    console.log('Database config:', {
        user: process.env.PG_USER,
        host: process.env.PG_HOST,
        database: process.env.PG_DATABASE,
        port: process.env.PG_PORT
    });
    
    const pool = new Pool({
        user: process.env.PG_USER,
        host: process.env.PG_HOST,
        database: process.env.PG_DATABASE,
        password: process.env.PG_PASSWORD,
        port: process.env.PG_PORT
    });

    try {
        // Add Raw Ingredient items
        const rawIngredientQuery = `
            INSERT INTO InventoryItems (sku, name, type, stock_level, unit_type)
            VALUES 
                ('RM-1001', 'Raw Cranberry Extract', 'Raw Ingredient', 1000, 'grams'),
                ('RM-1002', 'Honey', 'Raw Ingredient', 2000, 'grams')
            ON CONFLICT (sku) DO UPDATE 
            SET type = 'Raw Ingredient'
            RETURNING *
        `;
        const rawIngredientResult = await pool.query(rawIngredientQuery);
        console.log('Raw Ingredients added/updated:', rawIngredientResult.rows.length);

        // Add Component items
        const componentQuery = `
            INSERT INTO InventoryItems (sku, name, type, stock_level, unit_type)
            VALUES 
                ('CP-1001', 'Mixing Bowl', 'Component', 10, 'units'),
                ('CP-1002', 'Stirring Rod', 'Component', 20, 'units')
            ON CONFLICT (sku) DO UPDATE 
            SET type = 'Component'
            RETURNING *
        `;
        const componentResult = await pool.query(componentQuery);
        console.log('Components added/updated:', componentResult.rows.length);

        // Add Packaging items
        const packagingQuery = `
            INSERT INTO InventoryItems (sku, name, type, stock_level, unit_type)
            VALUES 
                ('PK-1001', 'Empty Capsules', 'Packaging', 5000, 'units'),
                ('PK-1002', 'Bottles', 'Packaging', 500, 'units')
            ON CONFLICT (sku) DO UPDATE 
            SET type = 'Packaging'
            RETURNING *
        `;
        const packagingResult = await pool.query(packagingQuery);
        console.log('Packaging added/updated:', packagingResult.rows.length);

        // Add Label items
        const labelQuery = `
            INSERT INTO InventoryItems (sku, name, type, stock_level, unit_type)
            VALUES 
                ('LB-1001', 'Product Labels', 'Label', 1000, 'units'),
                ('LB-1002', 'Warning Labels', 'Label', 2000, 'units')
            ON CONFLICT (sku) DO UPDATE 
            SET type = 'Label'
            RETURNING *
        `;
        const labelResult = await pool.query(labelQuery);
        console.log('Labels added/updated:', labelResult.rows.length);

        // Add Finished Good items
        const finishedGoodQuery = `
            INSERT INTO InventoryItems (sku, name, type, stock_level, unit_type)
            VALUES 
                ('FG-1001', 'Cranberry Extract Capsules', 'Finished Good', 100, 'units'),
                ('FG-1002', 'Honey Tablets', 'Finished Good', 200, 'units')
            ON CONFLICT (sku) DO UPDATE 
            SET type = 'Finished Good'
            RETURNING *
        `;
        const finishedGoodResult = await pool.query(finishedGoodQuery);
        console.log('Finished Goods added/updated:', finishedGoodResult.rows.length);

        // Check what inventory types we have now
        const checkTypesQuery = `
            SELECT type, COUNT(*) as count 
            FROM InventoryItems 
            GROUP BY type
        `;
        const typesResult = await pool.query(checkTypesQuery);
        console.log('Inventory types in database:');
        typesResult.rows.forEach(row => {
            console.log(`- ${row.type}: ${row.count} items`);
        });

    } catch (error) {
        console.error('Error adding inventory items:', error);
    } finally {
        await pool.end();
    }
}

// Run the script
addInventoryItems().catch(console.error); 