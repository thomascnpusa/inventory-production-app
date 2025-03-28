const { Pool } = require('pg');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

async function setupMMRDatabase() {
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
        // Read the SQL file
        const sqlFile = path.join(__dirname, 'setup-mmr.sql');
        const sql = await fs.readFile(sqlFile, 'utf8');

        // Execute the SQL
        await pool.query(sql);
        console.log('Successfully set up MMR tables');

        // Create raw material inventory items first
        const rawMaterialsQuery = `
            INSERT INTO InventoryItems (sku, name, type, stock_level, unit_type)
            VALUES 
                ('RM-1001', 'Raw Cranberry Extract', 'raw material', 1000, 'grams'),
                ('RM-1002', 'Empty Capsules', 'raw material', 5000, 'units')
            ON CONFLICT (sku) DO NOTHING
            RETURNING *
        `;
        await pool.query(rawMaterialsQuery);
        console.log('Created raw material inventory items');

        // Create a sample MMR
        const sampleMMR = {
            product_sku: 'P-15002.1',
            version: 1,
            base_quantity: 100,
            created_by: 'admin'
        };

        const mmrResult = await pool.query(`
            INSERT INTO MMRs (product_sku, version, base_quantity, created_by)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (product_sku, version) DO NOTHING
            RETURNING *
        `, [
            sampleMMR.product_sku,
            sampleMMR.version,
            sampleMMR.base_quantity,
            sampleMMR.created_by
        ]);

        if (mmrResult.rows.length > 0) {
            console.log('Created sample MMR');

            // Add sample ingredients
            const ingredientsQuery = `
                INSERT INTO MMRIngredients (mmr_product_sku, mmr_version, ingredient_sku, quantity, unit_type)
                VALUES 
                    ($1, $2, 'RM-1001', 50, 'grams'),
                    ($1, $2, 'RM-1002', 25, 'units')
                ON CONFLICT DO NOTHING
            `;
            await pool.query(ingredientsQuery, [sampleMMR.product_sku, sampleMMR.version]);

            // Add sample steps
            const stepsQuery = `
                INSERT INTO MMRSteps (mmr_product_sku, mmr_version, step_number, description, quality_checks)
                VALUES 
                    ($1, $2, 1, 'Mix ingredients thoroughly', 'Check mixture consistency'),
                    ($1, $2, 2, 'Fill capsules', 'Check capsule weight')
                ON CONFLICT DO NOTHING
            `;
            await pool.query(stepsQuery, [sampleMMR.product_sku, sampleMMR.version]);

            console.log('Added sample ingredients and steps');
        }

    } catch (error) {
        console.error('Error setting up MMR database:', error);
        throw error;
    } finally {
        await pool.end();
    }
}

// Run the setup
setupMMRDatabase().catch(console.error); 