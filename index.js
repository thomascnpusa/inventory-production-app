const express = require('express');
const dotenv = require('dotenv');
const path = require('path');
const { Pool } = require('pg');
const shopifyIntegration = require('./shopify');
const cron = require('node-cron');
const salesSyncService = require('./services/salesSync');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const { convert, getUnitCategory } = require('./utils/unitConversion');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');
const multer = require('multer'); // Added for file uploads
const fs = require('fs'); // Added for file system operations
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib'); // Added for server-side PDF
const fsPromises = require('fs').promises; // Use promises version of fs
const app = express();
const skuMappingRouter = require('./routes/skuMapping');
const inventoryRouter = require('./routes/inventory');
const productionOrdersRouter = require('./routes/productionOrders');

const { 
    authenticateToken, 
    checkPermission, 
    createUser, 
    loginUser, 
    logoutUser,
    ROLES 
} = require('./middleware/auth');

// Load environment variables
dotenv.config();


const PORT = process.env.PORT || 3000;

// Database connection
const pgPool = new Pool({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  password: process.env.PG_PASSWORD,
  port: process.env.PG_PORT
});

// Make the pool available to all routes
app.locals.pgPool = pgPool;

// Check if database columns exist and add them if they don't
async function checkAndAddColumns() {
    const client = await pgPool.connect();
    try {
        // Check if fba_inventory column exists
        const columnCheckResult = await client.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name='inventoryitems' AND column_name='fba_inventory'
        `);
        
        if (columnCheckResult.rows.length === 0) {
            console.log('Adding FBA inventory columns to InventoryItems table');
            
            // Add fba_inventory column
            await client.query(`
                ALTER TABLE InventoryItems
                ADD COLUMN fba_inventory INT DEFAULT 0
            `);
            
            // Add last_fba_update column
            await client.query(`
                ALTER TABLE InventoryItems
                ADD COLUMN last_fba_update TIMESTAMP
            `);
            
            // Create index for faster searches
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_inventory_fba ON InventoryItems(fba_inventory)
            `);
            
            console.log('Added FBA inventory columns to InventoryItems table');
        } else {
            console.log('FBA inventory columns already exist in InventoryItems table');
            
            // Now check for detailed FBA inventory columns
            const detailedColumnsCheck = await client.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name='inventoryitems' AND column_name='fba_available'
            `);
            
            if (detailedColumnsCheck.rows.length === 0) {
                console.log('Adding detailed FBA inventory columns');
                
                // Add detailed FBA inventory columns
                await client.query(`
                    ALTER TABLE InventoryItems
                    ADD COLUMN fba_available INT DEFAULT 0,
                    ADD COLUMN fba_inbound INT DEFAULT 0,
                    ADD COLUMN fba_reserved INT DEFAULT 0,
                    ADD COLUMN fba_unfulfillable INT DEFAULT 0,
                    ADD COLUMN fba_asin VARCHAR(20),
                    ADD COLUMN fba_condition VARCHAR(50),
                    ADD COLUMN fba_product_name TEXT
                `);
                
                console.log('Added detailed FBA inventory columns to InventoryItems table');
            } else {
                console.log('Detailed FBA inventory columns already exist');
            }
        }
    } catch (error) {
        console.error('Error checking or adding FBA inventory columns:', error);
    } finally {
        client.release();
    }
}

// Call after database connection is established
pgPool.connect().then(() => {
    console.log('Database connected successfully');
    checkAndAddColumns();
    // Existing code...
}).catch(err => {
    console.error('Error connecting to database:', err);
});

// Test database connection and initialize schema
pgPool.query('SELECT NOW()', async (err, res) => {
  if (err) {
    console.error('Database connection error:', err);
  } else {
    console.log('Database connected successfully');
    
    try {
      await pgPool.query(`
        ALTER TABLE ProductionSteps 
        ADD COLUMN IF NOT EXISTS completed BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS completed_by VARCHAR(50),
        ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP
      `);
      console.log('Added completion columns to ProductionSteps');
      
      await pgPool.query(`
        ALTER TABLE ProductionOrders 
        ADD COLUMN IF NOT EXISTS actual_yield DECIMAL,
        ADD COLUMN IF NOT EXISTS completed_by VARCHAR(50),
        ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP
      `);
      console.log('Added yield and completion columns to ProductionOrders');

      // Create ProductionOrderTestReports table if it doesn't exist - with explicit schema handling
      console.log('Attempting to create ProductionOrderTestReports table...');
      
      // First check if table exists
      const tableCheck = await pgPool.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'productionordertestreports'
        );
      `);
      
      if (!tableCheck.rows[0].exists) {
        console.log('ProductionOrderTestReports table does not exist, creating it...');
        await pgPool.query(`
          CREATE TABLE public.productionordertestreports (
              id SERIAL PRIMARY KEY,
              production_order_id INTEGER NOT NULL REFERENCES public.productionorders(id),
              filename VARCHAR(255) NOT NULL,
              original_filename VARCHAR(255) NOT NULL,
              file_path TEXT NOT NULL,
              mime_type VARCHAR(100) NOT NULL,
              uploaded_by_user_id INTEGER NOT NULL,
              uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              UNIQUE(production_order_id, filename)
          );
          
          -- Ensure proper permissions
          GRANT ALL PRIVILEGES ON TABLE public.productionordertestreports TO CURRENT_USER;
          GRANT USAGE, SELECT ON SEQUENCE public.productionordertestreports_id_seq TO CURRENT_USER;
        `);
        console.log('Successfully created ProductionOrderTestReports table');
      } else {
        console.log('ProductionOrderTestReports table already exists');
      }

    } catch (error) {
      console.error('Error setting up database schema:', error);
      // Log more details about the error
      if (error.code === '42P01') {
        console.error('Table does not exist error. Full error:', error);
      }
    }
  }
});

// Core middleware setup
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(cookieParser());
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: false
}));

// Database connection middleware - attach pgPool to all requests
app.use((req, res, next) => {
    req.pgPool = pgPool;
    next();
});

// Now register routes
app.use('/api/sku-mapping', skuMappingRouter);
app.use('/api/inventory', inventoryRouter);
app.use('/api/production-orders', productionOrdersRouter);

// Request logger middleware with more detail for production orders
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    
    // Special logging for production order routes
    if (req.url.includes('/production-orders')) {
        console.log('Production order route detected:');
        console.log('  URL:', req.url);
        console.log('  Method:', req.method);
        console.log('  Headers:', req.headers);
        console.log('  Body:', req.body);
    }
    
    next();
});

// Security middleware
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '1d', // Cache static assets for 1 day
    etag: true,   // Enable ETag for caching
    index: false  // Disable directory listing
}));

// Routes
app.get('/', (req, res) => {
    res.redirect('/login.html');
});

// Simple test endpoint to verify routing
app.get('/api/test', (req, res) => {
    console.log('Test endpoint called');
    res.json({ message: 'API is working correctly' });
});

// Amazon sync endpoint
app.post('/api/v1/sync/amazon', authenticateToken, async (req, res) => {
    console.log('Amazon sync endpoint called');
    try {
        const amazonSyncService = require('./services/salesSync');
        await amazonSyncService.syncAmazon();
        res.json({ success: true, message: 'Amazon sync completed successfully' });
    } catch (error) {
        console.error('Error during Amazon sync:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Shopify sync endpoint
app.post('/api/v1/sync/shopify', authenticateToken, async (req, res) => {
    console.log('Shopify sync endpoint called');
    try {
        const shopifySyncService = require('./services/salesSync');
        await shopifySyncService.syncShopify();
        res.json({ success: true, message: 'Shopify sync completed successfully' });
    } catch (error) {
        console.error('Error during Shopify sync:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// All platforms sync endpoint
app.post('/api/v1/sync/all', authenticateToken, async (req, res) => {
    console.log('All platforms sync endpoint called');
    try {
        const allSyncService = require('./services/salesSync');
        await allSyncService.syncAllPlatforms();
        res.json({ success: true, message: 'All platforms sync completed successfully' });
    } catch (error) {
        console.error('Error during all platforms sync:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Sync status endpoint
app.get('/api/sales/sync/status', authenticateToken, async (req, res) => {
    console.log('Sync status endpoint called');
    try {
        const syncService = require('./services/salesSync');
        const status = await syncService.getSyncStatus();
        res.json(status);
    } catch (error) {
        console.error('Error getting sync status:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/v1/production-orders/simple', authenticateToken, checkPermission('create_production_order'), async (req, res) => {
    console.log('Simple production order creation endpoint called');
    console.log('Request body:', req.body);
    const { product_sku, quantity, mmr_product_sku, mmr_version, due_date } = req.body;

    const validatedFields = {
        product_sku,
        quantity: Number(quantity),
        mmr_product_sku,
        mmr_version: Number(mmr_version),
        due_date: due_date || null
    };
    console.log('Validated fields:', validatedFields);

    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');

        const mmrCheck = await client.query(
            `SELECT COUNT(*) as count 
             FROM MMRs 
             WHERE product_sku = $1 AND version = $2 AND is_active = TRUE`,
            [validatedFields.mmr_product_sku, validatedFields.mmr_version]
        );
        console.log('MMR check result:', mmrCheck.rows[0], 'MMR exists:', mmrCheck.rows[0].count > 0);

        if (mmrCheck.rows[0].count === '0') {
            throw new Error('MMR not found or not active');
        }

        const mmrResult = await client.query(
            `SELECT base_quantity FROM MMRs 
             WHERE product_sku = $1 AND version = $2`,
            [validatedFields.mmr_product_sku, validatedFields.mmr_version]
        );
        const scalingFactor = validatedFields.quantity / mmrResult.rows[0].base_quantity;

        const ingredientsResult = await client.query(`
            SELECT mi.*, ii.id as item_id, ii.unit_type as inventory_unit_type, ii.stock_level, ii.sku
            FROM MMRIngredients mi 
            JOIN InventoryItems ii ON mi.ingredient_sku = ii.sku 
            WHERE mi.mmr_product_sku = $1 AND mi.mmr_version = $2`,
            [validatedFields.mmr_product_sku, validatedFields.mmr_version]
        );

        const batchNumber = `P${new Date().toISOString().slice(2, 10).replace(/-/g, '')}${await getDailySequence(client, validatedFields.mmr_product_sku, validatedFields.mmr_version)}`;

        const orderResult = await client.query(
            `INSERT INTO ProductionOrders 
            (product_sku, quantity, status, mmr_product_sku, mmr_version, mmr_base_quantity, finished_batch_number, due_date) 
            VALUES ($1, $2, 'Pending', $3, $4, $5, $6, $7) 
            RETURNING *`,
            [validatedFields.product_sku, validatedFields.quantity, validatedFields.mmr_product_sku, validatedFields.mmr_version, mmrResult.rows[0].base_quantity, batchNumber, validatedFields.due_date]
        );
        const orderId = orderResult.rows[0].id;
        console.log('Order inserted:', orderResult.rows[0]);

        let stepNumber = 1;
        let ingredientsDescription = 'Gather all required ingredients';
        if (ingredientsResult.rows.length > 0) {
            const ingredientList = ingredientsResult.rows.map(ing => {
                const scaledQuantity = parseFloat(ing.quantity) * scalingFactor;
                const ingredientName = ing.name || ing.sku;
                return `${ingredientName} (${ing.sku}): ${scaledQuantity.toFixed(2)} ${ing.unit_type}`;
            }).join(', ');
            ingredientsDescription = `Gather all required ingredients: ${ingredientList}`;

            for (const ingredient of ingredientsResult.rows) {
                const requiredQuantity = ingredient.quantity * scalingFactor;
                let requiredQuantityInInventoryUnits = convert(
                    requiredQuantity,
                    ingredient.unit_type,
                    ingredient.inventory_unit_type
                );
                console.log(`Converted ${requiredQuantity} ${ingredient.unit_type} to ${requiredQuantityInInventoryUnits} ${ingredient.inventory_unit_type} for ${ingredient.sku}`);

                if (requiredQuantityInInventoryUnits > ingredient.stock_level) {
                    throw new Error(`Insufficient stock for ${ingredient.sku}: need ${requiredQuantityInInventoryUnits}, have ${ingredient.stock_level}`);
                }

                const batchesResult = await client.query(`
                    SELECT ib.id, ib.batch_number, ib.stock_level, ib.created_at
                    FROM InventoryBatches ib
                    WHERE ib.inventory_item_id = $1 AND ib.stock_level > 0
                    ORDER BY ib.created_at ASC`,
                    [ingredient.item_id]
                );

                let remainingQuantity = requiredQuantityInInventoryUnits;

                for (const batch of batchesResult.rows) {
                    if (remainingQuantity <= 0) break;
                    
                    const quantityToUse = Math.min(batch.stock_level, remainingQuantity);
                    
                    await client.query(
                        `INSERT INTO ProductionBatches 
                        (production_order_id, item_id, quantity_used, batch_number, item_type) 
                        VALUES ($1, $2, $3::numeric, $4, 'raw_ingredient')`,
                        [orderId, ingredient.item_id, quantityToUse, batch.batch_number]
                    );
                    
                    await client.query(
                        `UPDATE InventoryBatches 
                         SET stock_level = stock_level - $1 
                         WHERE id = $2`,
                        [quantityToUse, batch.id]
                    );
                    
                    remainingQuantity -= quantityToUse;
                }
                
                if (remainingQuantity > 0) {
                    console.log(`Using ${remainingQuantity} units from main inventory for ${ingredient.sku}`);
                    const fallbackBatch = await client.query(
                        `SELECT batch_number FROM InventoryBatches 
                         WHERE inventory_item_id = $1 AND stock_level > 0 
                         ORDER BY created_at DESC LIMIT 1`,
                        [ingredient.item_id]
                    );
                    const batchNumberToUse = fallbackBatch.rows.length > 0 ? fallbackBatch.rows[0].batch_number : 'UNASSIGNED';
                    await client.query(
                        `INSERT INTO ProductionBatches 
                        (production_order_id, item_id, quantity_used, batch_number, item_type) 
                        VALUES ($1, $2, $3::numeric, $4, 'raw_ingredient')`,
                        [orderId, ingredient.item_id, remainingQuantity, batchNumberToUse]
                    );
                    
                    await client.query(
                        `UPDATE InventoryItems 
                         SET stock_level = stock_level - $1::numeric 
                         WHERE id = $2`,
                        [remainingQuantity, ingredient.item_id]
                    );
                }
            }
        }

        await client.query(
            `INSERT INTO ProductionSteps 
            (production_order_id, step_number, description, quality_checks) 
            VALUES ($1, $2, $3, '[]')`,
            [orderId, stepNumber++, ingredientsDescription]
        );

        // Insert equipment into ProductionSteps
        const equipmentResult = await client.query(
            `SELECT equipment_name 
             FROM MMREquipment 
             WHERE mmr_product_sku = $1 AND mmr_version = $2`,
            [validatedFields.mmr_product_sku, validatedFields.mmr_version]
        );
        let equipmentDescription = 'Prepare all required equipment';
        if (equipmentResult.rows.length > 0) {
            const equipmentList = equipmentResult.rows.map(eq => eq.equipment_name).join(', ');
            equipmentDescription = `Prepare all required equipment: ${equipmentList}`;
        }
        await client.query(
            `INSERT INTO ProductionSteps 
            (production_order_id, step_number, description, quality_checks) 
            VALUES ($1, $2, $3, '[]')`,
            [orderId, stepNumber++, equipmentDescription]
        );

        // Insert MMR steps
        const stepsResult = await client.query(
            'SELECT * FROM MMRSteps WHERE mmr_product_sku = $1 AND mmr_version = $2 ORDER BY step_number',
            [validatedFields.mmr_product_sku, validatedFields.mmr_version]
        );

        for (const step of stepsResult.rows) {
            await client.query(
                `INSERT INTO ProductionSteps 
                (production_order_id, step_number, description, quality_checks) 
                VALUES ($1, $2, $3, '[]')`,
                [orderId, stepNumber++, step.description]
            );
        }

        // Insert packaging into ProductionBatches and ProductionSteps
        const packagingResult = await client.query(`
            SELECT mp.*, ii.id as item_id, ii.name as packaging_name, ii.unit_type, ii.sku 
            FROM MMRPackaging mp
            LEFT JOIN InventoryItems ii ON mp.packaging_sku = ii.sku
            WHERE mp.mmr_product_sku = $1 AND mp.mmr_version = $2`,
            [validatedFields.mmr_product_sku, validatedFields.mmr_version]
        );

        let packagingDescription = 'Package the finished product';
        if (packagingResult.rows.length > 0) {
            const packagingList = packagingResult.rows.map(pkg => {
                const scaledQuantity = parseFloat(pkg.quantity) * scalingFactor;
                const packageName = pkg.packaging_name || pkg.packaging_sku;
                return `${packageName} (${pkg.packaging_sku}): ${scaledQuantity.toFixed(2)} ${pkg.unit_type}`;
            }).join(', ');
            packagingDescription = `Package the finished product: ${packagingList}`;

            for (const pkg of packagingResult.rows) {
                const scaledQuantity = parseFloat(pkg.quantity) * scalingFactor;
                await client.query(
                    `INSERT INTO ProductionBatches 
                    (production_order_id, item_id, quantity_used, item_type) 
                    VALUES ($1, $2, $3::numeric, 'packaging')`,
                    [orderId, pkg.item_id, scaledQuantity]
                );
            }
        }

        await client.query(
            `INSERT INTO ProductionSteps 
            (production_order_id, step_number, description, quality_checks) 
            VALUES ($1, $2, $3, '[]')`,
            [orderId, stepNumber++, packagingDescription]
        );

        // Insert labels into ProductionBatches and ProductionSteps
        const labelsResult = await client.query(`
            SELECT ml.*, ii.id as item_id, ii.name as label_name, ii.unit_type, ii.sku 
            FROM MMRLabels ml
            LEFT JOIN InventoryItems ii ON ml.label_sku = ii.sku
            WHERE ml.mmr_product_sku = $1 AND ml.mmr_version = $2`,
            [validatedFields.mmr_product_sku, validatedFields.mmr_version]
        );

        let labelingDescription = 'Apply labels to packaged product';
        if (labelsResult.rows.length > 0) {
            const labelList = labelsResult.rows.map(label => {
                const scaledQuantity = parseFloat(label.quantity) * scalingFactor;
                const labelName = label.label_name || label.label_sku;
                return `${labelName} (${label.label_sku}): ${scaledQuantity.toFixed(2)} ${label.unit_type}`;
            }).join(', ');
            labelingDescription = `Apply labels to packaged product: ${labelList}`;

            for (const lbl of labelsResult.rows) {
                const scaledQuantity = parseFloat(lbl.quantity) * scalingFactor;
                await client.query(
                    `INSERT INTO ProductionBatches 
                    (production_order_id, item_id, quantity_used, item_type) 
                    VALUES ($1, $2, $3::numeric, 'label')`,
                    [orderId, lbl.item_id, scaledQuantity]
                );
            }
        }

        await client.query(
            `INSERT INTO ProductionSteps 
            (production_order_id, step_number, description, quality_checks) 
            VALUES ($1, $2, $3, '[]')`,
            [orderId, stepNumber, labelingDescription]
        );

        console.log(`Created ${stepNumber} production steps with MMR data`);
        await client.query('COMMIT');
        res.status(201).json({ 
            id: orderId,
            batch_number: batchNumber,
            due_date: validatedFields.due_date,
            message: 'Production order created successfully'
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Transaction error:', err);
        res.status(500).json({ error: 'Failed to create production order', details: err.message });
    } finally {
        client.release();
    }
});

async function getDailySequence(client, product_sku, version) {
    const formattedDate = new Date().toISOString().slice(2, 10).replace(/-/g, '');
    const result = await client.query(
        `SELECT COUNT(*) as count 
         FROM ProductionOrders 
         WHERE finished_batch_number LIKE $1`,
        [`P${formattedDate}%`]
    );
    const count = parseInt(result.rows[0].count, 10);
    if (count >= 9) throw new Error('Max 9 production orders per day exceeded');
    return count + 1;
}

async function getDailySequence(client, product_sku, version) {
    const formattedDate = new Date().toISOString().slice(2, 10).replace(/-/g, '');
    const result = await client.query(
        `SELECT COUNT(*) as count 
         FROM ProductionOrders 
         WHERE finished_batch_number LIKE $1`,
        [`P${formattedDate}%`]
    );
    const count = parseInt(result.rows[0].count, 10);
    if (count >= 9) throw new Error('Max 9 production orders per day exceeded');
    return count + 1;
}

app.get('/index.html', authenticateToken, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/mmr.html', authenticateToken, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'mmr.html'));
});

app.get('/production-process.html', authenticateToken, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'production-process.html'));
});

// Authentication endpoints
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, email, password, role } = req.body;
        
        // Only allow admin role to be set by existing admins
        if (role === ROLES.ADMIN) {
            return res.status(403).json({ error: 'Cannot create admin users through this endpoint' });
        }

        const user = await createUser(username, email, password, role);
        res.status(201).json({ message: 'User created successfully', user });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const result = await loginUser(username, password);
        res.json(result);
    } catch (err) {
        res.status(401).json({ error: err.message });
    }
});

app.post('/api/auth/logout', authenticateToken, async (req, res) => {
    try {
        const token = req.headers['authorization'].split(' ')[1];
        await logoutUser(token);
        res.json({ message: 'Logged out successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Protected routes with role-based access control
app.post('/api/inventory', authenticateToken, checkPermission('create_inventory'), async (req, res) => {
    const { sku, name, type, stock_level, unit_type, batch_number, supplier_id, minimum_quantity } = req.body;
    try {
        const result = await pgPool.query(
            'INSERT INTO InventoryItems (sku, name, type, stock_level, unit_type, batch_number, supplier_id, minimum_quantity) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
            [sku, name, type, stock_level, unit_type, batch_number, supplier_id, minimum_quantity]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/inventory', async (req, res) => {
    try {
        const searchTerm = req.query.search || '';
        const type = req.query.type || '';
        const hasAmazonFba = req.query.hasAmazonFba === 'true';
        const hasAmazonMapping = req.query.hasAmazonMapping === 'true';

        // Pagination and Sorting Parameters
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50; // Default limit 50
        const offset = (page - 1) * limit;
        const sortBy = req.query.sortBy || 'sku'; // Default sort by sku
        const sortDir = req.query.sortDir === 'desc' ? 'DESC' : 'ASC'; // Default ASC

        console.log('Inventory request:', { searchTerm, type, hasAmazonFba, hasAmazonMapping, page, limit, sortBy, sortDir });

        // Build WHERE clause
        let whereClause = 'WHERE ii.is_active = TRUE';
        const queryParams = [];
        let paramIndex = 1;

        if (searchTerm) {
            queryParams.push(`%${searchTerm}%`);
            // Adjust the WHERE clause to search SKU or Name
            whereClause += ` AND (LOWER(ii.sku) LIKE LOWER($${paramIndex}) OR LOWER(ii.name) LIKE LOWER($${paramIndex}))`;
            paramIndex++;
        }

        if (type) {
            queryParams.push(type);
            whereClause += ` AND ii.type ILIKE $${paramIndex}`;
            paramIndex++;
        }

        if (hasAmazonFba) {
            whereClause += ` AND ii.fba_inventory > 0`;
        }
        
        if (hasAmazonMapping) {
            whereClause += ` AND EXISTS (
                SELECT 1 FROM SkuMapping 
                WHERE SkuMapping.internal_sku = ii.sku 
                AND SkuMapping.platform = 'amazon'
            )`;
        }

        // Validate sortBy column to prevent SQL injection
        const allowedSortColumns = ['sku', 'name', 'type', 'total_stock', 'fba_inventory', 'total_available', 'minimum_quantity', 'unit_type'];
        // Use a mapping for column names to avoid direct injection and handle calculated fields
        const sortColumnMapping = {
            'sku': 'ii.sku',
            'name': 'ii.name',
            'type': 'ii.type',
            'total_stock': 'total_stock', // Referencing the calculated alias
            'fba_inventory': 'ii.fba_inventory',
            'total_available': 'total_available', // Referencing the calculated alias
            'minimum_quantity': 'ii.minimum_quantity',
            'unit_type': 'ii.unit_type'
        };
        const safeSortBy = sortColumnMapping[sortBy] || 'ii.sku'; // Default to sku

        // --- Count Query for Total Items ---
        // We need to adjust the parameter indices for the count query
        const countParams = queryParams.slice(); // Use a copy
        let countQuery = `SELECT COUNT(*) FROM InventoryItems ii ${whereClause}`;
        console.log('Executing count query:', { countQuery, countParams });
        const countResult = await pgPool.query(countQuery, countParams);

        const totalItems = parseInt(countResult.rows[0].count);
        const totalPages = Math.ceil(totalItems / limit);


        // --- Main Query for Items ---
        // Add LIMIT and OFFSET parameters to the main query params array
        const itemsParams = queryParams.slice(); // Use a copy
        itemsParams.push(limit, offset);
        // Ensure correct parameter numbering for LIMIT and OFFSET
        const limitParamIndex = paramIndex;
        const offsetParamIndex = paramIndex + 1;

         let itemsQuery = `
            WITH InventoryWithCalculated AS (
                 SELECT
                    ii.*,
                    COALESCE((SELECT SUM(stock_level) FROM InventoryBatches WHERE inventory_item_id = ii.id), ii.stock_level, 0) as total_stock,
                    (COALESCE((SELECT SUM(stock_level) FROM InventoryBatches WHERE inventory_item_id = ii.id), ii.stock_level, 0) + COALESCE(ii.fba_inventory, 0)) as total_available
                FROM InventoryItems ii
                ${whereClause}
             )
            SELECT
                iwc.*, -- Select all columns from the CTE
                 json_build_object(
                    'total', COALESCE(iwc.fba_inventory, 0),
                    'available', COALESCE(iwc.fba_available, 0),
                    'inbound', COALESCE(iwc.fba_inbound, 0),
                    'reserved', COALESCE(iwc.fba_reserved, 0),
                    'unfulfillable', COALESCE(iwc.fba_unfulfillable, 0),
                    'asin', iwc.fba_asin,
                    'condition', iwc.fba_condition,
                    'product_name', iwc.fba_product_name,
                    'last_update', iwc.last_fba_update
                ) as fba_details,
                 COALESCE(json_agg(
                    CASE WHEN ib.id IS NOT NULL THEN
                        json_build_object(
                            'id', ib.id,
                            'batch_number', ib.batch_number,
                            'stock_level', ib.stock_level,
                            'created_at', ib.created_at,
                            'updated_at', ib.updated_at
                             -- Add receipt data here if needed for the main list view
                         )
                    ELSE NULL
                    END
                ) FILTER (WHERE ib.id IS NOT NULL), '[]'::json) as batches
             FROM InventoryWithCalculated iwc -- Select from the CTE
             LEFT JOIN InventoryBatches ib ON iwc.id = ib.inventory_item_id
             GROUP BY iwc.id, iwc.sku, iwc.name, iwc.type, iwc.stock_level, iwc.unit_type, iwc.batch_number, iwc.supplier_id, iwc.minimum_quantity, iwc.created_at, iwc.updated_at, iwc.is_active, iwc.fba_inventory, iwc.last_fba_update, iwc.fba_available, iwc.fba_inbound, iwc.fba_reserved, iwc.fba_unfulfillable, iwc.fba_asin, iwc.fba_condition, iwc.fba_product_name, iwc.total_stock, iwc.total_available -- Need to group by all non-aggregated columns from CTE
             ORDER BY ${safeSortBy} ${sortDir}
             LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}
         `;

        console.log('Executing items query:', { itemsQuery, itemsParams });
        const itemsResult = await pgPool.query(itemsQuery, itemsParams);


        console.log(`Found ${itemsResult.rows.length} items for page ${page}. Total items: ${totalItems}, Total pages: ${totalPages}`);

        // Send the response in the correct format
        res.json({
            items: itemsResult.rows,
            pagination: {
                currentPage: page,
                totalPages: totalPages,
                totalItems: totalItems,
                limit: limit
            }
        });
    } catch (err) {
        console.error('Error fetching inventory items:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get inventory item by SKU with batches
app.get('/api/inventory/:sku', async (req, res) => {
    try {
        // First query to get the inventory item and its batches
        const inventoryResult = await pgPool.query(`
            SELECT 
                ii.*,
                COALESCE(json_agg(
                    CASE WHEN ib.id IS NOT NULL THEN
                        json_build_object(
                            'id', ib.id,
                            'batch_number', ib.batch_number,
                            'stock_level', ib.stock_level,
                            'created_at', ib.created_at,
                            'updated_at', ib.updated_at
                        )
                    ELSE NULL
                    END
                ) FILTER (WHERE ib.id IS NOT NULL), '[]'::json) as batches,
                (SELECT SUM(stock_level) FROM InventoryBatches WHERE inventory_item_id = ii.id) as warehouse_stock,
                (COALESCE((SELECT SUM(stock_level) FROM InventoryBatches WHERE inventory_item_id = ii.id), ii.stock_level) + COALESCE(ii.fba_inventory, 0)) as total_available,
                json_build_object(
                    'total', COALESCE(ii.fba_inventory, 0),
                    'available', COALESCE(ii.fba_available, 0),
                    'inbound', COALESCE(ii.fba_inbound, 0),
                    'reserved', COALESCE(ii.fba_reserved, 0),
                    'unfulfillable', COALESCE(ii.fba_unfulfillable, 0),
                    'asin', ii.fba_asin,
                    'condition', ii.fba_condition,
                    'product_name', ii.fba_product_name,
                    'last_update', ii.last_fba_update
                ) as fba_details
            FROM InventoryItems ii
            LEFT JOIN InventoryBatches ib ON ii.id = ib.inventory_item_id
            WHERE ii.sku = $1
            GROUP BY ii.id
        `, [req.params.sku]);
        
        if (inventoryResult.rows.length === 0) {
            return res.status(404).json({ error: 'Item not found' });
        }

        const item = inventoryResult.rows[0];
        
        // If there are batches, get receipt data for each batch
        if (item.batches && item.batches.length > 0) {
            // Get all receipts for this SKU
            const receiptsResult = await pgPool.query(`
                SELECT * FROM InventoryReceipts 
                WHERE sku = $1
                ORDER BY created_at DESC
            `, [req.params.sku]);
            
            // Map receipts to batches by batch number (case insensitive)
            const receiptsByBatch = {};
            receiptsResult.rows.forEach(receipt => {
                if (receipt.batch_number) {
                    const batchKey = receipt.batch_number.toLowerCase();
                    if (!receiptsByBatch[batchKey] || new Date(receipt.created_at) > new Date(receiptsByBatch[batchKey].created_at)) {
                        receiptsByBatch[batchKey] = receipt;
                    }
                }
            });
            
            // Enhance each batch with receipt data
            item.batches = item.batches.map(batch => {
                const batchKey = batch.batch_number.toLowerCase();
                const receipt = receiptsByBatch[batchKey];
                
                if (receipt) {
                    return {
                        ...batch,
                        receipt_number: receipt.receipt_number,
                        supplier: receipt.supplier,
                        delivery_date: receipt.delivery_date,
                        expiration_date: receipt.expiration_date,
                        notes: receipt.notes
                    };
                }
                
                return batch;
            });
        }
        
        res.json(item);
    } catch (err) {
        console.error('Error fetching inventory item:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get inventory items by batch number
app.get('/api/inventory/batch/:batchNumber', async (req, res) => {
    try {
        const result = await pgPool.query('SELECT * FROM InventoryItems WHERE batch_number = $1', [req.params.batchNumber]);
        // Return with consistent response structure
        res.json({
            items: result.rows,
            pagination: {
                currentPage: 1,
                totalPages: 1,
                totalItems: result.rows.length,
                limit: result.rows.length
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update inventory item
app.put('/api/inventory/:sku', async (req, res) => {
    console.log('PUT /api/inventory/:sku - Request received:', {
        sku: req.params.sku,
        body: req.body
    });
    
    const { name, type, stock_level, unit_type, batch_number, supplier_id, minimum_quantity } = req.body;
    
    try {
        console.log('Executing SQL query with parameters:', {
            name, 
            type, 
            stock_level, 
            unit_type, 
            batch_number, 
            supplier_id, 
            minimum_quantity,
            sku: req.params.sku
        });
        
        const result = await pgPool.query(
            'UPDATE InventoryItems SET name = $1, type = $2, stock_level = $3, unit_type = $4, batch_number = $5, supplier_id = $6, minimum_quantity = $7 WHERE sku = $8 RETURNING *',
            [name, type, stock_level, unit_type, batch_number, supplier_id, minimum_quantity, req.params.sku]
        );
        
        if (result.rows.length === 0) {
            console.log(`Item not found with SKU: ${req.params.sku}`);
            return res.status(404).json({ error: 'Item not found' });
        }
        
        console.log('Update successful:', result.rows[0]);
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error updating inventory item:', err);
        res.status(500).json({ error: err.message });
    }
});

// Update stock level
app.patch('/api/inventory/:sku/stock', async (req, res) => {
    const { stock_level } = req.body;
    try {
        const result = await pgPool.query(
            'UPDATE InventoryItems SET stock_level = $1 WHERE sku = $2 RETURNING *',
            [stock_level, req.params.sku]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Item not found' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get inventory items by type (raw ingredient or finished good)
app.get('/api/inventory/type/:type', async (req, res) => {
    try {
        // Make the type match case-insensitive with ILIKE
        const requestedType = req.params.type;
        console.log(`Searching for inventory with type similar to: "${requestedType}"`);
        
        // Use a case-insensitive query that also matches with or without spaces
        const result = await pgPool.query(
            `SELECT * FROM InventoryItems 
             WHERE LOWER(type) ILIKE LOWER($1) 
             OR LOWER(type) ILIKE LOWER($2)
             OR LOWER(type) ILIKE LOWER($3)`,
            [`%${requestedType}%`, 
             `%${requestedType.replace(/\s+/g, '')}%`, 
             `%${requestedType.replace(/\s+/g, ' ')}%`]
        );
        
        console.log(`Found ${result.rows.length} items with type matching "${requestedType}"`);
        
        // Log first few items if any found
        if (result.rows.length > 0) {
            console.log('Sample matches:');
            result.rows.slice(0, 3).forEach(item => {
                console.log(`  ${item.sku}: "${item.type}"`);
            });
        }
        
        // Return with consistent response structure that matches what the main inventory endpoint returns
        res.json({
            items: result.rows,
            pagination: {
                currentPage: 1,
                totalPages: 1,
                totalItems: result.rows.length,
                limit: result.rows.length
            }
        });
    } catch (err) {
        console.error('Error in inventory type query:', err);
        res.status(500).json({ error: err.message });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    
    // Log all registered routes
    console.log("Registered routes:");
    app._router.stack.forEach(function(r){
        if (r.route && r.route.path){
            console.log(`${Object.keys(r.route.methods).join(', ')} ${r.route.path}`);
        }
    });
});

// Get specific steps from an MMR (used for displaying substeps in production process)
app.get('/api/v1/mmr/:sku/:version/steps', authenticateToken, async (req, res) => {
  const { sku, version } = req.params;
  
  try {
    const result = await pgPool.query(`
      SELECT * FROM MMRSteps
      WHERE mmr_product_sku = $1 AND mmr_version = $2
      ORDER BY step_number
    `, [sku, version]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching MMR steps:', error);
    res.status(500).json({ error: 'Failed to fetch MMR steps' });
  }
});

// Get substeps for a specific main step in an MMR
app.get('/api/v1/mmr/:sku/:version/substeps/:stepNumber', authenticateToken, async (req, res) => {
  const { sku, version, stepNumber } = req.params;
  
  try {
    console.log(`Fetching substeps for MMR ${sku}/${version}, step ${stepNumber}`);
    
    // First check if the MMR exists
    const mmrCheck = await pgPool.query(`
      SELECT COUNT(*) FROM MMRs 
      WHERE product_sku = $1 AND version = $2
    `, [sku, version]);
    
    if (mmrCheck.rows[0].count === '0') {
      console.log(`MMR not found: ${sku}/${version}`);
      return res.status(404).json({ error: 'MMR not found', message: 'No MMR record exists for this product.' });
    }
    
    // Check if the step exists
    const stepCheck = await pgPool.query(`
      SELECT COUNT(*) FROM MMRSteps
      WHERE mmr_product_sku = $1 AND mmr_version = $2 AND step_number = $3
    `, [sku, version, stepNumber]);
    
    if (stepCheck.rows[0].count === '0') {
      console.log(`Step ${stepNumber} not found in MMR ${sku}/${version}`);
      return res.status(404).json({ error: 'Step not found', message: `Step ${stepNumber} does not exist in this MMR.` });
    }
    
    // Query for the substeps
    const result = await pgPool.query(`
      SELECT * FROM MMRSubSteps
      WHERE mmr_product_sku = $1 AND mmr_version = $2 AND main_step_number = $3
      ORDER BY sub_step_number
    `, [sku, version, stepNumber]);
    
    console.log(`Found ${result.rows.length} substeps for MMR ${sku}/${version}, step ${stepNumber}`);
    
    // Even if we find 0 substeps, return a 200 status with an empty array
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching MMR substeps:', error);
    res.status(500).json({ error: 'Failed to fetch MMR substeps' });
  }
});

// Debug endpoint to check and create test substeps
app.get('/api/debug/create-test-substeps/:sku/:version/:stepNumber', async (req, res) => {
  const { sku, version, stepNumber } = req.params;
  
  try {
    // First check if the MMR exists
    const mmrCheck = await pgPool.query(`
      SELECT COUNT(*) FROM MMRs 
      WHERE product_sku = $1 AND version = $2
    `, [sku, version]);
    
    if (mmrCheck.rows[0].count === '0') {
      return res.status(404).json({ error: 'MMR not found', message: 'No MMR record exists for this product.' });
    }
    
    // Check if the step exists
    const stepCheck = await pgPool.query(`
      SELECT COUNT(*) FROM MMRSteps
      WHERE mmr_product_sku = $1 AND mmr_version = $2 AND step_number = $3
    `, [sku, version, stepNumber]);
    
    if (stepCheck.rows[0].count === '0') {
      return res.status(404).json({ error: 'Step not found', message: `Step ${stepNumber} does not exist in this MMR.` });
    }
    
    // Check if substeps already exist
    const substepsCheck = await pgPool.query(`
      SELECT COUNT(*) FROM MMRSubSteps
      WHERE mmr_product_sku = $1 AND mmr_version = $2 AND main_step_number = $3
    `, [sku, version, stepNumber]);
    
    const substepsCount = parseInt(substepsCheck.rows[0].count);
    console.log(`Found ${substepsCount} substeps for MMR ${sku}/${version}, step ${stepNumber}`);
    
    // If no substeps exist, create test substeps
    if (substepsCount === 0) {
      // Begin transaction
      await pgPool.query('BEGIN');
      
      // Create 3 test substeps
      await pgPool.query(`
        INSERT INTO MMRSubSteps (mmr_product_sku, mmr_version, main_step_number, sub_step_number, description, step_type)
        VALUES 
          ($1, $2, $3, '1.1', 'First substep: Prepare the equipment', 'sub'),
          ($1, $2, $3, '1.2', 'Second substep: Begin the process', 'sub'),
          ($1, $2, $3, '1.3', 'Quality check: Verify proper execution', 'qc')
      `, [sku, version, stepNumber]);
      
      // Commit the transaction
      await pgPool.query('COMMIT');
      
      console.log(`Created 3 test substeps for MMR ${sku}/${version}, step ${stepNumber}`);
      
      // Fetch the created substeps
      const createdSubsteps = await pgPool.query(`
        SELECT * FROM MMRSubSteps
        WHERE mmr_product_sku = $1 AND mmr_version = $2 AND main_step_number = $3
        ORDER BY sub_step_number
      `, [sku, version, stepNumber]);
      
      return res.json({
        message: 'Created test substeps',
        substeps: createdSubsteps.rows
      });
    }
    
    // If substeps already exist, just return them
    const existingSubsteps = await pgPool.query(`
      SELECT * FROM MMRSubSteps
      WHERE mmr_product_sku = $1 AND mmr_version = $2 AND main_step_number = $3
      ORDER BY sub_step_number
    `, [sku, version, stepNumber]);
    
    return res.json({
      message: 'Existing substeps found',
      substeps: existingSubsteps.rows
    });
    
  } catch (error) {
    console.error('Error in debug substeps endpoint:', error);
    
    // If there was an error during transaction, rollback
    try {
      await pgPool.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Error during rollback:', rollbackError);
    }
    
    return res.status(500).json({ 
      error: 'Failed to check/create substeps',
      details: error.message,
      stack: error.stack
    });
    }
});

// Debug endpoint to force-update production steps
app.get('/api/debug/production-orders/:id/update-steps', async (req, res) => {
  const orderId = req.params.id;
  
  try {
    console.log(`Force-updating steps for production order ${orderId}`);
    
    // First get the production order details
    const orderResult = await pgPool.query(`
      SELECT po.*, m.base_quantity 
      FROM ProductionOrders po
      LEFT JOIN MMRs m ON po.mmr_product_sku = m.product_sku AND po.mmr_version = m.version
      WHERE po.id = $1
    `, [orderId]);
    
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Production order not found' });
    }
    
    const order = orderResult.rows[0];
    console.log(`Found production order: ${JSON.stringify(order)}`);
    
    // Calculate scaling factor
    const baseQuantity = parseFloat(order.base_quantity) || 100;
    const scalingFactor = order.quantity / baseQuantity;
    console.log(`Scaling factor: ${scalingFactor} (${order.quantity} / ${baseQuantity})`);
    
    // Get MMR ingredients
    const ingredientsResult = await pgPool.query(`
      SELECT mi.*, ii.name as ingredient_name
      FROM MMRIngredients mi
      LEFT JOIN InventoryItems ii ON mi.ingredient_sku = ii.sku
      WHERE mi.mmr_product_sku = $1 AND mi.mmr_version = $2
    `, [order.mmr_product_sku, order.mmr_version]);
    
    console.log(`Found ${ingredientsResult.rows.length} ingredients from MMR`);
    
    // Get MMR equipment
    const equipmentResult = await pgPool.query(`
      SELECT *
      FROM MMREquipment
      WHERE mmr_product_sku = $1 AND mmr_version = $2
    `, [order.mmr_product_sku, order.mmr_version]);
    
    console.log(`Found ${equipmentResult.rows.length} equipment items from MMR`);
    
    // Get MMR steps and substeps
    const mmrStepsResult = await pgPool.query(`
      SELECT *
      FROM MMRSteps
      WHERE mmr_product_sku = $1 AND mmr_version = $2
      ORDER BY step_number
    `, [order.mmr_product_sku, order.mmr_version]);
    
    console.log(`Found ${mmrStepsResult.rows.length} steps from MMR`);
    
    const substepsResult = await pgPool.query(`
      SELECT * FROM MMRSubSteps
      WHERE mmr_product_sku = $1 AND mmr_version = $2
      ORDER BY main_step_number, sub_step_number
    `, [order.mmr_product_sku, order.mmr_version]);
    
    console.log(`Found ${substepsResult.rows.length} substeps from MMR`);
    
    // Get packaging and labels info
    const packagingResult = await pgPool.query(`
      SELECT mp.*, ii.name as packaging_name
      FROM MMRPackaging mp
      LEFT JOIN InventoryItems ii ON mp.packaging_sku = ii.sku
      WHERE mp.mmr_product_sku = $1 AND mp.mmr_version = $2
    `, [order.mmr_product_sku, order.mmr_version]);
    
    const labelsResult = await pgPool.query(`
      SELECT ml.*, ii.name as label_name
      FROM MMRLabels ml
      LEFT JOIN InventoryItems ii ON ml.label_sku = ii.sku
      WHERE ml.mmr_product_sku = $1 AND ml.mmr_version = $2
    `, [order.mmr_product_sku, order.mmr_version]);
    
    // Get existing steps
    const stepsResult = await pgPool.query(`
      SELECT *
      FROM ProductionSteps
      WHERE production_order_id = $1
      ORDER BY step_number
    `, [orderId]);
    
    if (stepsResult.rows.length === 0) {
      return res.status(404).json({ error: 'No steps found for this production order' });
    }
    
    // Start transaction to update steps
    await pgPool.query('BEGIN');
    
    try {
      // Create a mapping of main steps to their substeps
      const substepsByMainStep = {};
      substepsResult.rows.forEach(substep => {
        if (!substepsByMainStep[substep.main_step_number]) {
          substepsByMainStep[substep.main_step_number] = [];
        }
        substepsByMainStep[substep.main_step_number].push(substep);
      });
      
      // Update ingredients step
      if (ingredientsResult.rows.length > 0) {
        const ingredientList = ingredientsResult.rows.map(ing => {
          const scaledQuantity = (parseFloat(ing.quantity) * scalingFactor).toFixed(2);
          const itemName = ing.ingredient_name || ing.ingredient_sku;
          return `${itemName} (${ing.ingredient_sku}): ${scaledQuantity} ${ing.unit_type}`;
        }).join(', ');
        
        await pgPool.query(`
          UPDATE ProductionSteps
          SET description = $1
          WHERE production_order_id = $2 AND step_number = 1
        `, [`Gather all required ingredients: ${ingredientList}`, orderId]);
      }
      
      // Update equipment step
      if (equipmentResult.rows.length > 0) {
        const equipmentList = equipmentResult.rows.map(eq => eq.equipment_name).join(', ');
        
        await pgPool.query(`
          UPDATE ProductionSteps
          SET description = $1
          WHERE production_order_id = $2 AND step_number = 2
        `, [`Prepare all required equipment: ${equipmentList}`, orderId]);
      }
      
      // Update manufacturing steps with substep counts
      for (let i = 0; i < mmrStepsResult.rows.length; i++) {
        const step = mmrStepsResult.rows[i];
        let stepDescription = step.description;
        
        // Add substeps to description if they exist
        if (substepsByMainStep[step.step_number] && substepsByMainStep[step.step_number].length > 0) {
          const substepCount = substepsByMainStep[step.step_number].length;
          stepDescription += ` (${substepCount} detailed steps in MMR)`;
        }
        
        // Step numbers in ProductionSteps may be offset by 2 (for ingredients and equipment)
        await pgPool.query(`
          UPDATE ProductionSteps
          SET description = $1
          WHERE production_order_id = $2 AND step_number = $3
        `, [stepDescription, orderId, i + 3]);
      }
      
      // Update packaging step
      if (packagingResult.rows.length > 0) {
        const packagingList = packagingResult.rows.map(pkg => {
          const scaledQuantity = (parseFloat(pkg.quantity) * scalingFactor).toFixed(2);
          const packageName = pkg.packaging_name || pkg.packaging_sku;
          return `${packageName} (${pkg.packaging_sku}): ${scaledQuantity} ${pkg.unit_type}`;
        }).join(', ');
        
        // Packaging step is typically one of the last steps
        await pgPool.query(`
          UPDATE ProductionSteps
          SET description = $1
          WHERE production_order_id = $2 AND step_number = $3
        `, [`Package the finished product: ${packagingList}`, orderId, stepsResult.rows.length - 1]);
      }
      
      // Update labeling step
      if (labelsResult.rows.length > 0) {
        const labelList = labelsResult.rows.map(label => {
          const scaledQuantity = (parseFloat(label.quantity) * scalingFactor).toFixed(2);
          const labelName = label.label_name || label.label_sku;
          return `${labelName} (${label.label_sku}): ${scaledQuantity} ${label.unit_type}`;
        }).join(', ');
        
        // Labeling step is typically the last step
        await pgPool.query(`
          UPDATE ProductionSteps
          SET description = $1
          WHERE production_order_id = $2 AND step_number = $3
        `, [`Apply labels to packaged product: ${labelList}`, orderId, stepsResult.rows.length]);
      }
      
      await pgPool.query('COMMIT');
      
      // Get the updated steps
      const updatedStepsResult = await pgPool.query(`
        SELECT *
        FROM ProductionSteps
        WHERE production_order_id = $1
        ORDER BY step_number
      `, [orderId]);
      
      return res.json({
        message: 'Steps updated successfully',
        steps: updatedStepsResult.rows
      });
    } catch (error) {
      await pgPool.query('ROLLBACK');
      console.error('Error updating steps:', error);
      return res.status(500).json({ error: 'Failed to update steps', details: error.message });
    }
  } catch (error) {
    console.error('Error in debug endpoint:', error);
    res.status(500).json({ error: 'Server error', details: error.message });
  }
});

// Test endpoint for Amazon integration
app.get('/api/test/amazon', async (req, res) => {
    console.log('Amazon test endpoint called');
    try {
        res.json({ 
            message: 'Amazon integration is loaded correctly',
            success: true,
            test_data: {
                env_variables: {
                    AMAZON_CLIENT_ID: process.env.AMAZON_CLIENT_ID ? 'Set' : 'Not Set',
                    AMAZON_CLIENT_SECRET: process.env.AMAZON_CLIENT_SECRET ? 'Set' : 'Not Set',
                    AMAZON_REFRESH_TOKEN: process.env.AMAZON_REFRESH_TOKEN ? 'Set' : 'Not Set',
                    AMAZON_US_MARKETPLACE_ID: process.env.AMAZON_US_MARKETPLACE_ID ? 'Set' : 'Not Set'
                },
                timestamp: new Date().toISOString()
            }
        });
    } catch (error) {
        console.error('Error in Amazon test endpoint:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Initialize SKU mapping table
const skuMapping = require('./mapping');

// Initialize the SKU mapping table when the app starts
(async function() {
    try {
        await skuMapping.setupSkuMappingTable();
        console.log('SKU mapping table initialized');
    } catch (error) {
        console.error('Error initializing SKU mapping table:', error);
    }
})();

// SKU Mapping API endpoints
app.get('/api/sku-mappings', authenticateToken, async (req, res) => {
    try {
        const { platform, search, limit = 100, offset = 0 } = req.query;
        const mappings = await skuMapping.getAllSkuMappings(
            platform || null, 
            search || null,
            parseInt(limit),
            parseInt(offset)
        );
        
        const totalCount = await skuMapping.countSkuMappings(platform || null, search || null);
        
        res.json({
            mappings,
            total: totalCount,
            page: Math.floor(parseInt(offset) / parseInt(limit)) + 1,
            pageSize: parseInt(limit),
            totalPages: Math.ceil(totalCount / parseInt(limit))
        });
    } catch (error) {
        console.error('Error fetching SKU mappings:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/sku-mappings', authenticateToken, checkPermission('manage_sales'), async (req, res) => {
    try {
        const { platformSku, internalSku, platform, productName } = req.body;
        
        if (!platformSku || !internalSku || !platform) {
            return res.status(400).json({ error: 'Platform SKU, internal SKU, and platform are required' });
        }
        
        const success = await skuMapping.addSkuMapping(platformSku, internalSku, platform, productName);
        
        if (success) {
            res.json({ success: true, message: 'SKU mapping added successfully' });
        } else {
            res.status(500).json({ error: 'Failed to add SKU mapping' });
        }
    } catch (error) {
        console.error('Error adding SKU mapping:', error);
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/sku-mappings/:id', authenticateToken, checkPermission('manage_sales'), async (req, res) => {
    try {
        const { id } = req.params;
        
        const success = await skuMapping.deleteSkuMapping(id);
        
        if (success) {
            res.json({ success: true, message: 'SKU mapping deleted successfully' });
        } else {
            res.status(500).json({ error: 'Failed to delete SKU mapping' });
        }
    } catch (error) {
        console.error('Error deleting SKU mapping:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/sku-mappings/bulk', authenticateToken, checkPermission('manage_sales'), async (req, res) => {
    try {
        const { mappings } = req.body;
        
        if (!Array.isArray(mappings) || mappings.length === 0) {
            return res.status(400).json({ error: 'Mappings array is required and must not be empty' });
        }
        
        const result = await skuMapping.bulkUploadSkuMappings(mappings);
        
        res.json({
            success: true,
            message: `${result.successCount} mappings imported successfully, ${result.failCount} failed`,
            ...result
        });
    } catch (error) {
        console.error('Error bulk uploading SKU mappings:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/sku-mappings/suggest/:platform', authenticateToken, checkPermission('view_sales'), async (req, res) => {
    try {
        const { platform } = req.params;
        const { threshold = 0.7 } = req.query;
        
        const suggestions = await skuMapping.suggestMappings(platform, parseFloat(threshold));
        
        res.json({
            success: true,
            suggestions,
            count: suggestions.length
        });
    } catch (error) {
        console.error('Error suggesting SKU mappings:', error);
        res.status(500).json({ error: error.message });
    }
});

// Test endpoint to add a test Amazon SKU to the mapping table
app.get('/api/test/add-test-sku', async (req, res) => {
    try {
        const client = await pgPool.connect();
        try {
            console.log('Adding test Amazon SKU to mapping table...');
            
            // First, get the table structure to determine what columns we have
            const tableInfo = await client.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = 'skumapping'
            `);
            
            const columns = tableInfo.rows.map(row => row.column_name);
            console.log('Available columns:', columns);
            
            // Insert using only basic columns that we know exist
            await client.query(`
                INSERT INTO SkuMapping (platform_sku, platform, internal_sku, product_name) 
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (platform_sku, platform) DO NOTHING
            `, ['TEST-SKU-1234', 'amazon', 'TEST-INTERNAL-SKU', 'Test Product']);
            
            const result = await client.query('SELECT * FROM SkuMapping WHERE platform_sku = $1', ['TEST-SKU-1234']);
            
            res.json({
                message: 'Test SKU added successfully',
                sku: result.rows.length > 0 ? result.rows[0] : null,
                availableColumns: columns
            });
        } catch (error) {
            console.error('Database error:', error);
            res.status(500).json({ error: error.message });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Test endpoint to view all SKU mappings
app.get('/api/test/sku-mappings', async (req, res) => {
    try {
        const platform = req.query.platform || null;
        const searchTerm = req.query.search || null;
        const limit = parseInt(req.query.limit || '100');
        const offset = parseInt(req.query.offset || '0');
        
        console.log(`Test endpoint: Getting ${limit} SKU mappings for platform ${platform || 'all'}`);
        
        const mappings = await skuMapping.getAllSkuMappings(platform, searchTerm, limit, offset);
        const total = await skuMapping.countSkuMappings(platform, searchTerm);
        
        res.json({
            mappings,
            total,
            limit,
            offset,
            platform
        });
    } catch (error) {
        console.error(`Error getting SKU mappings: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// Test endpoint for Amazon sync without authentication (for debugging)
app.post('/api/test/sync/amazon', async (req, res) => {
    // Set a response timeout
    const timeoutMs = 30000; // 30 seconds
    let hasResponded = false;
    
    // Create a timeout to ensure we respond even if sync hangs
    const responseTimeout = setTimeout(() => {
        if (!hasResponded) {
            hasResponded = true;
            console.log('Amazon sync timeout - forcing response after 30 seconds');
            res.status(202).json({ 
                status: 'partial_success', 
                message: 'Amazon sync started but taking too long. It will continue in the background.' 
            });
        }
    }, timeoutMs);
    
    try {
        console.log('Test endpoint: Syncing Amazon orders...');
        
        // Start sync in background without awaiting it
        const syncPromise = salesSyncService.syncAmazon();
        
        // Wait for either completion or timeout
        const result = await Promise.race([
            syncPromise,
            new Promise(resolve => setTimeout(() => resolve({ status: 'timeout' }), timeoutMs - 1000))
        ]);
        
        // Clear the timeout if we got a response in time
        clearTimeout(responseTimeout);
        
        if (!hasResponded) {
            hasResponded = true;
            if (result.status === 'timeout') {
                res.status(202).json({ 
                    status: 'in_progress', 
                    message: 'Amazon sync is taking longer than expected. It will continue in the background.' 
                });
            } else {
                res.json(result);
            }
        }
    } catch (error) {
        clearTimeout(responseTimeout);
        if (!hasResponded) {
            hasResponded = true;
            console.error('Test endpoint error:', error);
            res.status(500).json({ error: error.message });
        }
    }
});

app.post('/api/test/sync/shopify', async (req, res) => {
    // Set a response timeout
    const timeoutMs = 30000; // 30 seconds
    let hasResponded = false;
    
    // Create a timeout to ensure we respond even if sync hangs
    const responseTimeout = setTimeout(() => {
        if (!hasResponded) {
            hasResponded = true;
            console.log('Shopify sync timeout - forcing response after 30 seconds');
            res.status(202).json({ 
                status: 'partial_success', 
                message: 'Shopify sync started but taking too long. It will continue in the background.' 
            });
        }
    }, timeoutMs);
    
    try {
        console.log('Test endpoint: Syncing Shopify orders for the last hour...');
        
        // Start sync in background without awaiting it
        const syncPromise = salesSyncService.syncShopify();
        
        // Wait for either completion or timeout
        const result = await Promise.race([
            syncPromise,
            new Promise(resolve => setTimeout(() => resolve({ status: 'timeout' }), timeoutMs - 1000))
        ]);
        
        // Clear the timeout if we got a response in time
        clearTimeout(responseTimeout);
        
        if (!hasResponded) {
            hasResponded = true;
            if (result.status === 'timeout') {
                res.status(202).json({ 
                    status: 'in_progress', 
                    message: 'Shopify sync is taking longer than expected. It will continue in the background.' 
                });
            } else {
                res.json({ success: true, message: 'Shopify sync completed', result });
            }
        }
    } catch (error) {
        clearTimeout(responseTimeout);
        if (!hasResponded) {
            hasResponded = true;
            console.error('Test endpoint error:', error);
            res.status(500).json({ error: error.message });
        }
    }
});

// API endpoint for testing SKU auto-suggestion feature
app.get('/api/test/sku-mappings/suggest/:platform', async (req, res) => {
    try {
        console.log(`Test endpoint: Suggesting mappings for ${req.params.platform}...`);
        const suggestions = await skuMapping.suggestMappings(req.params.platform);
        res.json(suggestions);
    } catch (error) {
        console.error(`Error suggesting SKU mappings: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// Add a test endpoint to import Amazon SKUs without actually fetching orders
app.get('/api/test/import-amazon-skus', async (req, res) => {
    try {
        console.log('Test endpoint: Importing sample Amazon SKUs...');
        
        // Sample Amazon SKUs for testing
        const testSkus = [
            'AMZN-SKU-001', 'AMZN-SKU-002', 'AMZN-SKU-003', 'AMZN-SKU-004', 'AMZN-SKU-005',
            'AMZN-SKU-006', 'AMZN-SKU-007', 'AMZN-SKU-008', 'AMZN-SKU-009', 'AMZN-SKU-010',
            'AMZN-SKU-WIDGET-S', 'AMZN-SKU-WIDGET-M', 'AMZN-SKU-WIDGET-L',
            'AMZN-SKU-GADGET-RED', 'AMZN-SKU-GADGET-BLUE', 'AMZN-SKU-GADGET-GREEN'
        ];
        
        const client = await pgPool.connect();
        try {
            // First check which SKUs already exist
            const existingResult = await client.query(`
                SELECT platform_sku FROM SkuMapping 
                WHERE platform = 'amazon' AND platform_sku LIKE 'AMZN-SKU-%'
            `);
            const existingSkus = new Set(existingResult.rows.map(row => row.platform_sku));
            
            // Filter out the SKUs that already exist
            const newSkus = testSkus.filter(sku => !existingSkus.has(sku));
            
            if (newSkus.length > 0) {
                // Insert new SKUs with batch insert
                const values = [];
                const valueStrings = [];
                
                newSkus.forEach((sku, index) => {
                    // Extract a possible product name from the SKU
                    let productName = null;
                    if (sku.includes('WIDGET')) {
                        const size = sku.split('-').pop();
                        productName = `Sample Widget ${size} Size`;
                    } else if (sku.includes('GADGET')) {
                        const color = sku.split('-').pop();
                        productName = `Sample Gadget ${color} Color`;
                    } else {
                        productName = `Sample Product ${index + 1}`;
                    }
                    
                    values.push('amazon', sku, null, productName, 0, 'unmapped');
                    valueStrings.push(`($${index * 6 + 1}, $${index * 6 + 2}, $${index * 6 + 3}, $${index * 6 + 4}, $${index * 6 + 5}, $${index * 6 + 6})`);
                });
                
                const insertQuery = `
                    INSERT INTO SkuMapping 
                    (platform, platform_sku, internal_sku, product_name, confidence, status) 
                    VALUES ${valueStrings.join(',')}
                    ON CONFLICT (platform_sku, platform) DO NOTHING
                `;
                
                await client.query(insertQuery, values);
                console.log(`Added ${newSkus.length} new test Amazon SKUs to mapping table`);
                
                res.json({ 
                    message: 'Successfully imported test Amazon SKUs',
                    added: newSkus.length,
                    skus: newSkus
                });
            } else {
                res.json({ 
                    message: 'All test SKUs already exist in mapping table',
                    added: 0 
                });
            }
        } finally {
            client.release();
        }
    } catch (error) {
        console.error(`Error importing test Amazon SKUs: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// API endpoint to test adding a single SKU
app.get('/api/test/add-test-sku', async (req, res) => {
    try {
        const client = await pgPool.connect();
        try {
            console.log('Adding test Amazon SKU to mapping table...');
            
            // First, get the table structure to determine what columns we have
            const tableInfo = await client.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = 'skumapping'
            `);
            
            const columns = tableInfo.rows.map(row => row.column_name);
            console.log('Available columns:', columns);
            
            // Insert using only basic columns that we know exist
            await client.query(`
                INSERT INTO SkuMapping (platform_sku, platform, internal_sku, product_name) 
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (platform_sku, platform) DO NOTHING
            `, ['TEST-SKU-1234', 'amazon', 'TEST-INTERNAL-SKU', 'Test Product']);
            
            const result = await client.query('SELECT * FROM SkuMapping WHERE platform_sku = $1', ['TEST-SKU-1234']);
            
            res.json({
                message: 'Test SKU added successfully',
                sku: result.rows.length > 0 ? result.rows[0] : null,
                availableColumns: columns
            });
        } catch (error) {
            console.error('Database error:', error);
            res.status(500).json({ error: error.message });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Add a test endpoint to view SKU mappings without authentication
app.get('/api/test/sku-mappings', async (req, res) => {
    try {
        const platform = req.query.platform || null;
        const searchTerm = req.query.search || null;
        const limit = parseInt(req.query.limit || '100');
        const offset = parseInt(req.query.offset || '0');
        
        console.log(`Test endpoint: Getting ${limit} SKU mappings for platform ${platform || 'all'}`);
        
        const mappings = await skuMapping.getAllSkuMappings(platform, searchTerm, limit, offset);
        const total = await skuMapping.countSkuMappings(platform, searchTerm);
        
        res.json({
            mappings,
            total,
            limit,
            offset,
            platform
        });
    } catch (error) {
        console.error(`Error getting SKU mappings: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// Add a test endpoint to import sample Shopify SKUs
app.get('/api/test/import-shopify-skus', async (req, res) => {
    try {
        console.log('Test endpoint: Importing sample Shopify SKUs...');
        
        // Sample Shopify SKUs for testing
        const testSkus = [
            'SHOPIFY-SKU-001', 'SHOPIFY-SKU-002', 'SHOPIFY-SKU-003', 'SHOPIFY-SKU-004', 'SHOPIFY-SKU-005',
            'SHOPIFY-SKU-006', 'SHOPIFY-SKU-007', 'SHOPIFY-SKU-008', 'SHOPIFY-SKU-009', 'SHOPIFY-SKU-010',
            'SHOPIFY-SKU-WIDGET-S', 'SHOPIFY-SKU-WIDGET-M', 'SHOPIFY-SKU-WIDGET-L',
            'SHOPIFY-SKU-GADGET-RED', 'SHOPIFY-SKU-GADGET-BLUE', 'SHOPIFY-SKU-GADGET-GREEN'
        ];
        
        const client = await pgPool.connect();
        try {
            // First check which SKUs already exist
            const existingResult = await client.query(`
                SELECT platform_sku FROM SkuMapping 
                WHERE platform = 'shopify' AND platform_sku LIKE 'SHOPIFY-SKU-%'
            `);
            const existingSkus = new Set(existingResult.rows.map(row => row.platform_sku));
            
            // Filter out the SKUs that already exist
            const newSkus = testSkus.filter(sku => !existingSkus.has(sku));
            
            if (newSkus.length > 0) {
                // Insert new SKUs with batch insert
                const values = [];
                const valueStrings = [];
                
                newSkus.forEach((sku, index) => {
                    // Extract a possible product name from the SKU
                    let productName = null;
                    if (sku.includes('WIDGET')) {
                        const size = sku.split('-').pop();
                        productName = `Shopify Widget ${size} Size`;
                    } else if (sku.includes('GADGET')) {
                        const color = sku.split('-').pop();
                        productName = `Shopify Gadget ${color} Color`;
                    } else {
                        productName = `Shopify Product ${index + 1}`;
                    }
                    
                    values.push('shopify', sku, null, productName, 0, 'unmapped');
                    valueStrings.push(`($${index * 6 + 1}, $${index * 6 + 2}, $${index * 6 + 3}, $${index * 6 + 4}, $${index * 6 + 5}, $${index * 6 + 6})`);
                });
                
                const insertQuery = `
                    INSERT INTO SkuMapping 
                    (platform, platform_sku, internal_sku, product_name, confidence, status) 
                    VALUES ${valueStrings.join(',')}
                    ON CONFLICT (platform_sku, platform) DO NOTHING
                `;
                
                await client.query(insertQuery, values);
                console.log(`Added ${newSkus.length} new test Shopify SKUs to mapping table`);
                
                res.json({ 
                    message: 'Successfully imported test Shopify SKUs',
                    added: newSkus.length,
                    skus: newSkus
                });
            } else {
                res.json({ 
                    message: 'All test Shopify SKUs already exist in mapping table',
                    added: 0 
                });
            }
        } finally {
            client.release();
        }
    } catch (error) {
        console.error(`Error importing test Shopify SKUs: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// Add an endpoint to trigger real SKU syncs without authentication
app.post('/api/test/sync-skus', async (req, res) => {
    try {
        console.log('Test endpoint: Syncing SKUs from both Amazon and Shopify');
        
        // Sync Shopify first
        try {
            console.log('Starting Shopify sync...');
            await salesSyncService.syncShopify();
            console.log('Shopify sync completed');
        } catch (shopifyError) {
            console.error('Shopify sync error:', shopifyError);
        }
        
        // Then sync Amazon
        try {
            console.log('Starting Amazon sync...');
            await salesSyncService.syncAmazon();
            console.log('Amazon sync completed');
        } catch (amazonError) {
            console.error('Amazon sync error:', amazonError);
        }
        
        // Get current count of SKUs by platform
        const client = await pgPool.connect();
        try {
            const amazonResult = await client.query("SELECT COUNT(*) FROM SkuMapping WHERE platform = 'amazon'");
            const shopifyResult = await client.query("SELECT COUNT(*) FROM SkuMapping WHERE platform = 'shopify'");
            
            const amazonCount = parseInt(amazonResult.rows[0].count);
            const shopifyCount = parseInt(shopifyResult.rows[0].count);
            
            res.json({
                success: true,
                message: 'Sync process completed',
                skuCounts: {
                    amazon: amazonCount,
                    shopify: shopifyCount,
                    total: amazonCount + shopifyCount
                }
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error in sync process:', error);
        res.status(500).json({ error: error.message });
    }
});

// Add an endpoint to trigger imports of all SKUs for both platforms
app.post('/api/sku-mappings/import-all', authenticateToken, async (req, res) => {
    try {
        console.log('Starting import of all SKUs for both platforms...');
        const results = { amazon: null, shopify: null };
        
        // Start Amazon import
        try {
            console.log('Importing Amazon SKUs...');
            // Get Amazon orders from the last 90 days to extract SKUs
            const amazonData = await amazonIntegration.syncOrdersByChunks('US', 90, 10);
            console.log(`Amazon import completed, found ${amazonData.length} orders`);
            results.amazon = { status: 'success', ordersProcessed: amazonData.length };
        } catch (amazonError) {
            console.error('Error importing Amazon SKUs:', amazonError);
            results.amazon = { status: 'error', message: amazonError.message };
        }
        
        // Start Shopify import
        try {
            console.log('Importing Shopify SKUs...');
            const shopifyResults = await shopifyIntegration.syncAllStores(90);
            console.log('Shopify import completed:', shopifyResults);
            results.shopify = { status: 'success', results: shopifyResults };
        } catch (shopifyError) {
            console.error('Error importing Shopify SKUs:', shopifyError);
            results.shopify = { status: 'error', message: shopifyError.message };
        }
        
        res.json({
            success: true,
            message: 'SKU import completed',
            results
        });
    } catch (error) {
        console.error('Error importing SKUs:', error);
        res.status(500).json({
            success: false,
            message: 'Error importing SKUs',
            error: error.message
        });
    }
});

app.post('/api/test/sync-shopify-light', async (req, res) => {
    try {
        console.log('Light Shopify sync test...');
        const shopifyIntegration = require('./shopify');
        
        // Just get orders without processing them
        const startTime = new Date();
        const hoursBack = 1;
        const daysBack = hoursBack / 24;
        const storeName = 'CNPUSA'; // Just sync the USA store
        
        const orders = await shopifyIntegration.fetchOrders(storeName, daysBack);
        
        const endTime = new Date();
        const duration = (endTime - startTime) / 1000;
        
        res.json({ 
            success: true, 
            message: `Fetched ${orders.length} orders in ${duration} seconds`, 
            first_order: orders.length > 0 ? orders[0].id : null,
            last_order: orders.length > 0 ? orders[orders.length - 1].id : null
        });
    } catch (error) {
        console.error('Shopify light sync error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/test/process-shopify-order', async (req, res) => {
    try {
        console.log('Processing a single Shopify order for testing...');
        const shopifyIntegration = require('./shopify');
        
        // Get one order without processing it
        const storeName = 'CNPUSA';
        const daysBack = 1/24;
        
        // First fetch the orders
        const orders = await shopifyIntegration.fetchOrders(storeName, daysBack);
        
        if (orders.length === 0) {
            return res.json({ success: false, message: 'No orders found in the last hour' });
        }
        
        // Take just the first order
        const order = orders[0];
        console.log(`Processing single order ${order.id} with SKU(s): ${order.line_items.map(item => item.sku).join(', ')}`);
        
        // Process just this one order
        await shopifyIntegration.processOrders([order], storeName);
        
        res.json({ 
            success: true, 
            message: `Successfully processed order ${order.id}`,
            order_details: {
                id: order.id,
                customer: order.customer ? `${order.customer.firstName} ${order.customer.lastName}` : 'Unknown',
                skus: order.line_items.map(item => item.sku)
            }
        });
    } catch (error) {
        console.error('Error processing single Shopify order:', error);
        res.status(500).json({ error: error.message });
    }
});

// Test endpoint to create a sample Amazon order
app.get('/api/test/create-amazon-order', async (req, res) => {
    try {
        console.log('Creating sample Amazon order for testing...');
        
        const amazonIntegration = require('./amazon');
        
        // Create a sample Amazon order
        const sampleOrder = {
            AmazonOrderId: 'TEST-AMAZON-ORDER-' + Date.now(),
            OrderStatus: 'Shipped',
            PurchaseDate: new Date().toISOString(),
            BuyerInfo: {
                BuyerEmail: 'test@example.com'
            },
            OrderTotal: {
                Amount: '49.99',
                CurrencyCode: 'USD'
            },
            OrderItems: [
                {
                    OrderItemId: 'TEST-ITEM-1',
                    SellerSKU: '1001',
                    Title: 'Kidney Complete - 8oz',
                    QuantityOrdered: '5',
                    ItemPrice: {
                        Amount: '28.95',
                        CurrencyCode: 'USD'
                    },
                    ASIN: 'B00TEST1234'
                }
            ]
        };
        
        // ... existing code ...
    } catch (error) {
        console.error('Error creating sample Amazon order:', error);
        res.status(500).json({ error: error.message });
    }
});

// Test endpoint to create a specific test Amazon order for SKU 1001
app.get('/api/test/create-test-order-1001', async (req, res) => {
    try {
        console.log('Creating test Amazon order for SKU 1001...');
        
        const amazonIntegration = require('./amazon');
        
        // Create a sample Amazon order with SKU 1001
        const testOrder = {
            AmazonOrderId: 'TEST-1001-ORDER-' + Date.now(),
            OrderStatus: 'Shipped',
            PurchaseDate: new Date().toISOString(),
            BuyerInfo: {
                BuyerEmail: 'test@example.com'
            },
            OrderTotal: {
                Amount: '144.75',
                CurrencyCode: 'USD'
            },
            OrderItems: [
                {
                    OrderItemId: 'TEST-1001-ITEM',
                    SellerSKU: '1001',
                    Title: 'Kidney Complete - 8oz',
                    QuantityOrdered: '5',
                    ItemPrice: {
                        Amount: '28.95',
                        CurrencyCode: 'USD'
                    },
                    ASIN: 'B00KIDNEY01'
                }
            ]
        };
        
        // Process the test order
        await amazonIntegration.processOrders([testOrder], 'US');
        
        // Check the inventory levels before and after
        const client = await pgPool.connect();
        try {
            const inventoryResult = await client.query(
                `SELECT ii.sku, ib.batch_number, ib.stock_level 
                FROM InventoryItems ii 
                JOIN InventoryBatches ib ON ii.id = ib.inventory_item_id
                WHERE ii.sku = 'P-1001'`
            );
            
            const orderResult = await client.query(
                `SELECT so.platform_order_id, soi.product_sku, soi.quantity, sim.inventory_batch_number, sim.quantity as allocated_quantity 
                FROM SalesOrders so 
                JOIN SalesOrderItems soi ON so.id = soi.sales_order_id 
                LEFT JOIN SalesInventoryMapping sim ON soi.id = sim.sales_order_item_id
                WHERE so.platform_order_id = $1`,
                [testOrder.AmazonOrderId]
            );
            
            res.json({
                success: true,
                message: 'Test order for SKU 1001 processed successfully',
                order_id: testOrder.AmazonOrderId,
                inventory_status: inventoryResult.rows[0] || null,
                order_details: orderResult.rows
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error creating test order for SKU 1001:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            stack: error.stack
        });
    }
});

app.post('/api/forecast', authenticateToken, checkPermission('view_reports'), async (req, res) => {
    try {
        console.log('[Forecast API] Request received. Fetching data...'); // Log start
        
        const GROWTH_FACTOR = 1.1;
        
      // Fetch sales data with product names and current inventory (last 90 days)
      const salesQuery = `
        WITH inventory_totals AS (
          SELECT 
            ii.id,
            ii.sku,
            ii.name,
            ii.type,
            ii.stock_level as base_stock,
            COALESCE(SUM(ib.stock_level), 0) as batch_total,
            CASE 
              WHEN COUNT(ib.id) > 0 THEN COALESCE(SUM(ib.stock_level), 0)
              ELSE ii.stock_level
                    END as warehouse_stock,
                    COALESCE(ii.fba_inventory, 0) as fba_stock,
                    -- ii.batch_size -- Remove batch size from SELECT
                    1 as batch_size -- <<< TEMPORARY: Default batch size to 1
          FROM InventoryItems ii
          LEFT JOIN InventoryBatches ib ON ii.id = ib.inventory_item_id
          WHERE LOWER(ii.type) IN ('finished good') OR ii.type = 'Finished Good'
                GROUP BY ii.id, ii.sku, ii.name, ii.type, ii.stock_level, ii.fba_inventory--, ii.batch_size -- Remove from GROUP BY
        )
        SELECT 
          it.sku AS product_id,
          it.name AS product_name,
                it.warehouse_stock,
                it.fba_stock,
          it.type as product_type,
                it.batch_size, -- Keep selecting the temporary batch_size=1
          COALESCE(SUM(CASE WHEN so.order_date >= NOW() - INTERVAL '30 days' THEN soi.quantity ELSE 0 END), 0) AS units_sold_30d,
                COALESCE(SUM(CASE WHEN so.order_date >= NOW() - INTERVAL '60 days' THEN soi.quantity ELSE 0 END), 0) AS units_sold_60d, -- Total units in last 60 days
                COALESCE(SUM(CASE WHEN so.order_date >= NOW() - INTERVAL '90 days' THEN soi.quantity ELSE 0 END), 0) AS units_sold_90d -- Total units in last 90 days
        FROM inventory_totals it
        LEFT JOIN skumapping sm ON it.sku = sm.internal_sku
        LEFT JOIN SalesOrderItems soi ON (sm.platform_sku IS NOT NULL AND soi.product_sku = sm.platform_sku) 
                                      OR (sm.platform_sku IS NULL AND soi.product_sku = it.sku)
        LEFT JOIN SalesOrders so ON soi.sales_order_id = so.id AND so.order_date >= NOW() - INTERVAL '90 days'
            GROUP BY it.sku, it.name, it.warehouse_stock, it.fba_stock, it.type, it.batch_size
        ORDER BY it.name;
      `;
  
        const { rows: salesData } = await pgPool.query(salesQuery);
        console.log(`[Forecast API] Fetched sales data for ${salesData.length} products.`); // Log count
        
      const forecast = {};

        for (const item of salesData) {
            const product_id = item.product_id;
            const product_name = item.product_name;
            const BATCH_SIZE = Number(item.batch_size || 1); // Default batch size to 1 (using the temp value)

            // Get stock levels
            const whStock = Number(item.warehouse_stock || 0);
            const fbaStock = Number(item.fba_stock || 0);
            const totalStock = whStock + fbaStock;

            console.log(`[Forecast API] Processing SKU: ${product_id} - WH: ${whStock}, FBA: ${fbaStock}, Sold90d: ${item.units_sold_90d}`); // Log inputs

            // Get sales
            const sold30d = Number(item.units_sold_30d) || 0;
            const sold60d = Number(item.units_sold_60d) || 0;
            const sold90d = Number(item.units_sold_90d) || 0;

            // Calculate forecasts (original basis, for potential display)
            const forecast30d = Math.ceil((sold30d / 30) * 30 * GROWTH_FACTOR);
            const forecast60d = Math.ceil((sold60d / 60) * 30 * GROWTH_FACTOR); // Still project 30 days, using 60d avg
            const forecast90d = Math.ceil((sold90d / 90) * 30 * GROWTH_FACTOR); // Still project 30 days, using 90d avg

            // --- START NEW PRODUCTION CALCULATION LOGIC ---
            const WAREHOUSE_MIN_DAYS = 60;
            const FBA_MIN_DAYS = 90;
            const OVERALL_TARGET_DAYS = 90; // Target total stock level

            const avgDailySales90d = sold90d > 0 ? (sold90d / 90) : 0; // Use 90-day avg for calculations
            console.log(`[Forecast API] SKU: ${product_id} - AvgDailySales90d: ${avgDailySales90d}`); // Log avg sales

            // Calculate days remaining per location based on 90d avg sales
            const whDaysStockRemaining = avgDailySales90d > 0 ? Math.floor(whStock / avgDailySales90d) : Infinity;
            const fbaDaysStockRemaining = avgDailySales90d > 0 ? Math.floor(fbaStock / avgDailySales90d) : Infinity;
            // const totalDaysStockRemaining = avgDailySales90d > 0 ? Math.floor(totalStock / avgDailySales90d) : Infinity; // No longer needed

            // Calculate estimated run out date (for total stock)
            // let estRunOutDate = null; ... -> Remove old calculation
            
            // Calculate estimated run out dates for WH and FBA separately
            let estWhRunOutDate = null;
            if (whDaysStockRemaining !== Infinity && whDaysStockRemaining >= 0) {
                const runOutDate = new Date();
                runOutDate.setDate(runOutDate.getDate() + whDaysStockRemaining);
                estWhRunOutDate = runOutDate.toISOString().split('T')[0];
            }

            let estFbaRunOutDate = null;
            if (fbaDaysStockRemaining !== Infinity && fbaDaysStockRemaining >= 0) {
                const runOutDate = new Date();
                runOutDate.setDate(runOutDate.getDate() + fbaDaysStockRemaining);
                estFbaRunOutDate = runOutDate.toISOString().split('T')[0];
            }

            // Calculate needed to hit minimums per location
            const whMinTargetStock = avgDailySales90d * WAREHOUSE_MIN_DAYS;
            const fbaMinTargetStock = avgDailySales90d * FBA_MIN_DAYS;
            const whNeedToMin = Math.max(0, whMinTargetStock - whStock);
            const fbaNeedToMin = Math.max(0, fbaMinTargetStock - fbaStock);
            const totalNeedForMinimums = whNeedToMin + fbaNeedToMin;

            // Calculate needed to hit overall target stock level
            const overallTargetStock = avgDailySales90d * OVERALL_TARGET_DAYS;
            const totalNeedForOverallTarget = Math.max(0, overallTargetStock - totalStock);

            // Final production needed is the max of the two requirements
            let productionNeeded = Math.max(totalNeedForMinimums, totalNeedForOverallTarget);

            // Round UP to the nearest batch size (if batch_size > 1 and production is needed)
            // Keep this logic, it will just use BATCH_SIZE = 1 for now
            if (BATCH_SIZE > 1 && productionNeeded > 0) {
                productionNeeded = Math.ceil(productionNeeded / BATCH_SIZE) * BATCH_SIZE;
            } else {
                productionNeeded = Math.round(productionNeeded); // Otherwise, round to nearest whole unit
            }
            // --- END NEW PRODUCTION CALCULATION LOGIC ---

            // Structure the final forecast object for this SKU
            forecast[product_id] = {
                product_name: product_name || product_id,
                warehouse_stock: whStock,
                fba_stock: fbaStock,
                // Include original forecasts for context if needed
                forecast_30d: forecast30d,
                forecast_60d: forecast60d,
                forecast_90d: forecast90d, // Note: This is 30d projection based on 90d history
                batch_size: BATCH_SIZE, // Keep returning the batch size (currently 1)
                // Add new calculated fields
                whDaysStockRemaining: whDaysStockRemaining,
                fbaDaysStockRemaining: fbaDaysStockRemaining,
                // estRunOutDate: estRunOutDate, // Remove old combined date
                estWhRunOutDate: estWhRunOutDate, // Add WH specific date
                estFbaRunOutDate: estFbaRunOutDate, // Add FBA specific date
                productionNeeded: productionNeeded // Final calculated and rounded need
            };
        } // End for loop over salesData

        res.json({ forecast }); // Return the processed forecast data

    } catch (error) {
      console.error('Forecast error:', error.message);
        console.error('Full error stack:', error.stack); // Log the full stack trace
        res.status(500).json({ error: 'Internal server error', details: error.message }); // Send a more generic error to client
    }
  });

// Search endpoint for inventory items
app.get('/api/inventory/search', authenticateToken, checkPermission('view_inventory'), async (req, res) => {
    const { term } = req.query;
    
    try {
        if (!term) {
            return res.status(400).json({ error: 'Search term required' });
        }

        const query = `
            SELECT 
                ii.id,
                ii.sku,
                ii.name,
                ii.type,
                CASE 
                    WHEN COUNT(ib.id) > 0 THEN COALESCE(SUM(ib.stock_level), 0)
                    ELSE COALESCE(ii.stock_level, 0)
                END as current_stock
            FROM InventoryItems ii
            LEFT JOIN InventoryBatches ib ON ii.id = ib.inventory_item_id
            WHERE (ii.sku ILIKE $1 OR ii.name ILIKE $1) AND ii.is_active = TRUE -- Added filter
            GROUP BY ii.id, ii.sku, ii.name, ii.type
            ORDER BY ii.sku
            LIMIT 50
        `;
        
        const result = await pgPool.query(query, [`%${term}%`]);
        // Return with consistent response structure
        res.json({
            items: result.rows,
            pagination: {
                currentPage: 1,
                totalPages: 1,
                totalItems: result.rows.length,
                limit: 50
            }
        });
    } catch (error) {
        console.error('Inventory search error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get inventory by type endpoint
app.get('/api/inventory', authenticateToken, checkPermission('view_inventory'), async (req, res) => {
    try {
        const { type, search } = req.query;
        
        // Handle search parameter - this is used by the merge inventory feature
        if (search) {
            const searchQuery = `
                SELECT 
                    ii.sku,
                    ii.name,
                    ii.type,
                    CASE 
                        WHEN COUNT(ib.id) > 0 THEN COALESCE(SUM(ib.stock_level), 0)
                        ELSE COALESCE(ii.stock_level, 0)
                    END as current_stock
                FROM InventoryItems ii
                LEFT JOIN InventoryBatches ib ON ii.id = ib.inventory_item_id
                WHERE (ii.sku ILIKE $1 OR ii.name ILIKE $1)
                GROUP BY ii.id, ii.sku, ii.name, ii.type
                ORDER BY ii.sku
                LIMIT 50
            `;
            
            const result = await pgPool.query(searchQuery, [`%${search}%`]);
            // Return with consistent response structure
            return res.json({
                items: result.rows,
                pagination: {
                    currentPage: 1,
                    totalPages: 1,
                    totalItems: result.rows.length,
                    limit: 50
                }
            });
        }
        
        // Handle type parameter
        let query = `
            SELECT ii.*, 
                COALESCE(SUM(ib.stock_level), 0) as batch_stock,
                CASE 
                    WHEN COUNT(ib.id) > 0 THEN COALESCE(SUM(ib.stock_level), 0)
                    ELSE ii.stock_level
                END as current_stock
            FROM InventoryItems ii
            LEFT JOIN InventoryBatches ib ON ii.id = ib.inventory_item_id
        `;
        
        const queryParams = [];
        
        if (type) {
            query += ` WHERE ii.type = $1`;
            queryParams.push(type);
        }
        
        query += ` GROUP BY ii.id ORDER BY ii.name`;
        
        const inventoryResult = await pgPool.query(query, queryParams);
        
        // Return with consistent response structure
        res.json({
            items: inventoryResult.rows,
            pagination: {
                currentPage: 1,
                totalPages: 1,
                totalItems: inventoryResult.rows.length,
                limit: inventoryResult.rows.length
            }
        });
    } catch (error) {
        console.error('Error getting inventory:', error);
        res.status(500).json({ error: error.message });
    }
});

// Amazon FBA inventory sync endpoint
app.post('/api/v1/sync/fba-inventory', async (req, res) => {
    try {
        console.log('Starting FBA inventory sync...');
        const AmazonAPI = require('./amazon');
        const amazonClient = new AmazonAPI();
        const result = await amazonClient.fetchFBAInventory();
        
        if (result.success) {
            res.json({ 
                success: true, 
                message: result.message,
                updated_count: result.updatedCount || 0
            });
        } else {
            res.status(500).json({
                success: false,
                message: result.message || 'Failed to sync FBA inventory',
                error: result.error
            });
        }
    } catch (error) {
        console.error('Error during FBA inventory sync:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error syncing FBA inventory', 
            error: error.message 
        });
    }
});

// Test endpoint for FBA inventory sync without authentication (for debugging)
app.post('/api/test/sync/fba-inventory', async (req, res) => {
    console.log('Test endpoint: Syncing FBA inventory...');
    
    const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => {
            resolve({ 
                success: false, 
                message: 'FBA inventory sync is taking longer than expected. It will continue in the background.' 
            });
        }, 30000); // 30 second timeout
    });
    
    try {
        const amazonIntegration = require('./amazon');
        
        // Start the sync in the background
        const syncPromise = amazonIntegration.fetchFBAInventory();
        
        // Return whichever finishes first - the sync or the timeout
        const result = await Promise.race([syncPromise, timeoutPromise]);
        res.json(result);
    } catch (error) {
        console.error('Error in FBA inventory sync test endpoint:', error);
        res.status(500).json({ success: false, message: 'Error syncing FBA inventory', error: error.message });
    }
});

// Test endpoint for FBA inventory
app.get('/api/test/fba-inventory', async (req, res) => {
    console.log('Test endpoint: Testing FBA inventory...');
    try {
        const client = await pgPool.connect();
        try {
            // Check if fba_inventory column exists
            const columnCheckResult = await client.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name='inventoryitems' AND column_name='fba_inventory'
            `);
            
            if (columnCheckResult.rows.length === 0) {
                // Add fba_inventory column if it doesn't exist
                await client.query(`ALTER TABLE InventoryItems ADD COLUMN IF NOT EXISTS fba_inventory INT DEFAULT 0`);
                await client.query(`ALTER TABLE InventoryItems ADD COLUMN IF NOT EXISTS last_fba_update TIMESTAMP`);
                console.log('Added FBA inventory columns to database');
            }
            
            // Update a few items with test FBA inventory data
            await client.query(`
                UPDATE InventoryItems 
                SET fba_inventory = CASE
                    WHEN sku = 'P-1001' THEN 50
                    WHEN sku = 'P-1002' THEN 25
                    WHEN sku = 'P-1003' THEN 10
                    ELSE FLOOR(RANDOM() * 20)::INT
                END,
                last_fba_update = CURRENT_TIMESTAMP
                WHERE type = 'finished good'
            `);
            
            // Get the updated items
            const result = await client.query(`
                SELECT sku, name, fba_inventory, last_fba_update 
                FROM InventoryItems 
                WHERE fba_inventory > 0
                ORDER BY fba_inventory DESC
            `);
            
            res.json({
                success: true,
                message: 'Test FBA inventory data added',
                items: result.rows
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error in test FBA endpoint:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Simple test endpoint for FBA inventory
app.get('/api/test/fba-simple', async (req, res) => {
    console.log('Test endpoint: Simple FBA test...');
    try {
        const client = await pgPool.connect();
        try {
            // Add the columns if they don't exist
            await client.query(`
                ALTER TABLE InventoryItems 
                ADD COLUMN IF NOT EXISTS fba_inventory INT DEFAULT 0
            `);
            
            await client.query(`
                ALTER TABLE InventoryItems 
                ADD COLUMN IF NOT EXISTS last_fba_update TIMESTAMP
            `);
            
            // Update a specific SKU
            await client.query(`
                UPDATE InventoryItems 
                SET fba_inventory = 42, 
                    last_fba_update = CURRENT_TIMESTAMP
                WHERE sku = 'P-1001'
            `);
            
            // Get all inventory items
            const result = await client.query(`
                SELECT sku, name, type, stock_level, fba_inventory
                FROM InventoryItems 
                ORDER BY sku
                LIMIT 10
            `);
            
            res.json({
                success: true,
                message: 'FBA columns added and test data inserted',
                items: result.rows
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error in simple FBA test endpoint:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Test endpoint to add FBA inventory to multiple items
app.get('/api/test/fba-multiple', async (req, res) => {
    console.log('Test endpoint: Adding FBA inventory to multiple items...');
    try {
        const client = await pgPool.connect();
        try {
            // Add several items with FBA inventory
            await client.query(`
                UPDATE InventoryItems 
                SET 
                    fba_inventory = CASE
                        WHEN sku = 'P-1001' THEN 42
                        WHEN sku = 'P-1002' THEN 35
                        WHEN sku = 'P-1003' THEN 21
                        WHEN sku = 'P-2001' THEN 15
                        WHEN sku = 'P-2002' THEN 8
                        ELSE 0
                    END,
                    last_fba_update = CURRENT_TIMESTAMP
                WHERE sku IN ('P-1001', 'P-1002', 'P-1003', 'P-2001', 'P-2002')
            `);
            
            // Get the updated items
            const result = await client.query(`
                SELECT 
                    sku, 
                    name, 
                    type, 
                    stock_level AS warehouse_stock, 
                    fba_inventory,
                    (COALESCE(stock_level, 0) + COALESCE(fba_inventory, 0)) AS total_available
                FROM InventoryItems 
                WHERE fba_inventory > 0
                ORDER BY fba_inventory DESC
            `);
            
            res.json({
                success: true,
                message: 'FBA inventory added to multiple items',
                items: result.rows
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error adding multiple FBA inventory items:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Amazon FBA inventory sync endpoint (GET method)
app.get('/api/v1/sync/fba-inventory', authenticateToken, async (req, res) => {
    console.log('FBA inventory sync endpoint called (GET)');
    try {
        const AmazonAPI = require('./amazon');
        const amazonClient = new AmazonAPI();
        const result = await amazonClient.fetchFBAInventory();
        res.json(result);
    } catch (error) {
        console.error('Error during FBA inventory sync:', error);
        res.status(500).json({ success: false, message: 'Error syncing FBA inventory', error: error.message });
    }
});

// Test endpoint for FBA inventory sync without authentication (for debugging) - GET method
app.get('/api/test/sync/fba-inventory', async (req, res) => {
    console.log('Test endpoint: Syncing FBA inventory (GET)...');
    
    const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => {
            resolve({ 
                success: false, 
                message: 'FBA inventory sync is taking longer than expected. It will continue in the background.' 
            });
        }, 30000); // 30 second timeout
    });
    
    try {
        const amazonIntegration = require('./amazon');
        
        // Start the sync in the background
        const syncPromise = amazonIntegration.fetchFBAInventory();
        
        // Return whichever finishes first - the sync or the timeout
        const result = await Promise.race([syncPromise, timeoutPromise]);
        res.json(result);
    } catch (error) {
        console.error('Error in FBA inventory sync test endpoint:', error);
        res.status(500).json({ success: false, message: 'Error syncing FBA inventory', error: error.message });
    }
});

// Simple test for FBA inventory API
app.get('/api/test/fba-debug', async (req, res) => {
    console.log('FBA debug test endpoint called');
    try {
        const amazonIntegration = require('./amazon');
        const accessToken = await amazonIntegration.getAccessToken();
        const axios = require('axios');
        
        // Make a simple request to check if we have access
        const response = await axios.get('https://sellingpartnerapi-na.amazon.com/fba/inventory/v1/summaries', {
            headers: {
                'x-amz-access-token': accessToken,
                'Content-Type': 'application/json'
            },
            params: {
                marketplaceIds: 'ATVPDKIKX0DER',
                granularityType: 'Marketplace',
                granularityId: 'ATVPDKIKX0DER'
            }
        });
        
        res.json({
            success: true,
            message: 'Successfully connected to FBA inventory API',
            response: response.data
        });
    } catch (error) {
        console.error('FBA API test error:', error.message);
        console.error('Request details:', error.config);
        console.error('Response details:', error.response?.data);
        
        res.status(500).json({
            success: false,
            message: 'Error testing FBA inventory API',
            error: error.message,
            statusCode: error.response?.status,
            errorType: error.response?.headers?.['x-amzn-errortype'],
            errorData: error.response?.data
        });
    }
});

// Test endpoint using the dedicated fba-test.js file
app.get('/api/test/fba-client', async (req, res) => {
    try {
        const fbaTest = require('./fba-test');
        await fbaTest(req, res);
    } catch (error) {
        console.error('Error in FBA client test:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});
/*
// Workaround for FBA inventory using Amazon order data
app.get('/api/v1/sync/fba-from-orders', async (req, res) => {
    console.log('Syncing FBA inventory from orders...');
    try {
        const client = await pgPool.connect();
        try {
            // Check if we have the FBA columns
            const checkResult = await client.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name='inventoryitems' AND column_name='fba_inventory'
            `);
            
            if (checkResult.rows.length === 0) {
                // Add the FBA columns if they don't exist
                await client.query(`
                    ALTER TABLE InventoryItems
                    ADD COLUMN fba_inventory INT DEFAULT 0,
                    ADD COLUMN last_fba_update TIMESTAMP
                `);
                console.log('Added FBA inventory columns to InventoryItems table');
            }
            
            // Get all Amazon orders
            const orderResult = await client.query(`
                SELECT DISTINCT si.product_sku
                FROM SalesOrders so
                JOIN SalesOrderItems si ON so.id = si.sales_order_id
                WHERE so.platform = 'amazon'
            `);
            
            const amazonSkus = orderResult.rows.map(row => row.product_sku);
            console.log(`Found ${amazonSkus.length} SKUs from Amazon orders`);
            
            let updatedCount = 0;
            
            // Create simulated FBA inventory based on order history
            for (const sku of amazonSkus) {
                // Extract the base SKU without any prefixes like "P-"
                const baseSku = sku.replace(/^P-/, '');
                
                // Count orders for this SKU
                const countResult = await client.query(`
                    SELECT COUNT(*) AS order_count
                    FROM SalesOrders so
                    JOIN SalesOrderItems si ON so.id = si.sales_order_id
                    WHERE so.platform = 'amazon' AND si.product_sku = $1
                `, [sku]);
                
                const orderCount = parseInt(countResult.rows[0].order_count) || 0;
                
                // Generate a somewhat realistic FBA inventory number based on order volume
                // More orders = more likely to have FBA inventory
                let fbaInventory = 0;
                
                if (orderCount > 10) {
                    fbaInventory = Math.floor(orderCount * 2.5 + Math.random() * 20);
                } else if (orderCount > 5) {
                    fbaInventory = Math.floor(orderCount * 2 + Math.random() * 10);
                } else if (orderCount > 0) {
                    fbaInventory = Math.floor(orderCount + Math.random() * 5);
                }
                
                // Update the inventory record
                await client.query(`
                    UPDATE InventoryItems
                    SET fba_inventory = $1, last_fba_update = CURRENT_TIMESTAMP
                    WHERE sku = $2
                `, [fbaInventory, sku]);
                
                updatedCount++;
                console.log(`Updated ${sku} with ${fbaInventory} units of FBA inventory`);
            }
            
            res.json({
                success: true,
                message: `Successfully generated FBA inventory data for ${updatedCount} SKUs based on order history`,
                skus_updated: updatedCount
            });
            
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error generating FBA inventory data:', error);
        res.status(500).json({
            success: false,
            message: 'Error generating FBA inventory data',
            error: error.message
        });
    }
});
*/
// Test endpoint to verify FBA inventory API access
app.get('/api/test/fba-verify', async (req, res) => {
    console.log('Testing FBA inventory API with updated permissions...');
    try {
        const AmazonAPI = require('./amazon');
        const amazonClient = new AmazonAPI();
        const accessToken = await amazonClient.getAccessToken();
        const axios = require('axios');
        
        // Test the FBA inventory summary endpoint with the updated permissions
        const response = await axios.get('https://sellingpartnerapi-na.amazon.com/fba/inventory/v1/summaries', {
            headers: {
                'x-amz-access-token': accessToken,
                'Content-Type': 'application/json'
            },
            params: {
                marketplaceIds: process.env.AMAZON_US_MARKETPLACE_ID || 'ATVPDKIKX0DER',
                granularityType: 'Marketplace',
                granularityId: process.env.AMAZON_US_MARKETPLACE_ID || 'ATVPDKIKX0DER'
            }
        });
        
        console.log('FBA inventory API access successful!');
        res.json({
            success: true,
            message: 'Successfully accessed FBA inventory API with new permissions',
            itemCount: response.data?.payload?.inventorySummaries?.length || 0,
            sample: response.data?.payload?.inventorySummaries?.slice(0, 3) || []
        });
    } catch (error) {
        console.error('Error verifying FBA API access:', error.message);
        res.status(500).json({
            success: false,
            message: 'Error accessing FBA inventory API',
            error: error.message,
            statusCode: error.response?.status,
            errorType: error.response?.headers?.['x-amzn-errortype'],
            errorData: error.response?.data
        });
    }
});

// Test FBA inventory sync endpoint without authentication
app.get('/api/test/run-fba-sync', async (req, res) => {
    console.log('Running FBA inventory sync without authentication...');
    try {
        const AmazonAPI = require('./amazon');
        const amazonClient = new AmazonAPI();
        const result = await amazonClient.fetchFBAInventory();
        
        if (result.success) {
            res.json({
                success: true,
                updated: result.updated || 0,
                skipped: result.skipped || 0,
                message: 'FBA inventory sync completed successfully'
            });
        } else {
            res.status(500).json({
                success: false,
                message: result.message || 'Failed to sync FBA inventory',
                error: result.error
            });
        }
    } catch (error) {
        console.error('Error in FBA inventory sync test endpoint:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error syncing FBA inventory', 
            error: error.message 
        });
    }
});

// API route to add Amazon SKU mapping
app.post('/api/mapping/amazon', async (req, res) => {
    try {
        const { amazonSku, internalSku } = req.body;
        
        if (!amazonSku || !internalSku) {
            return res.status(400).json({ error: 'Both amazonSku and internalSku are required' });
        }
        
        const success = await skuMapping.addSkuMapping(amazonSku, internalSku, 'amazon');
        
        if (success) {
            // Refresh FBA inventory for this specific item
            const AmazonAPI = require('./amazon');
            const amazonClient = new AmazonAPI();
            await amazonClient.updateSingleFbaInventory(internalSku, amazonSku);
            
            return res.json({ 
                success: true, 
                message: `Successfully mapped Amazon SKU ${amazonSku} to internal SKU ${internalSku}`
            });
        } else {
            return res.status(500).json({ error: 'Failed to add SKU mapping' });
        }
    } catch (error) {
        console.error('Error adding Amazon SKU mapping:', error);
        res.status(500).json({ error: error.message });
    }
});

// API route to get SKU mappings
app.get('/api/mapping', async (req, res) => {
    try {
        const { platform, search, limit = 100, offset = 0 } = req.query;
        
        // Check if countSkuMappings method exists, otherwise implement a fallback
        let total = 0;
        if (typeof skuMapping.countSkuMappings === 'function') {
            total = await skuMapping.countSkuMappings(platform, search);
        } else {
            // Fallback: get all mappings without pagination and count them
            const allMappings = await skuMapping.getAllSkuMappings(platform, search);
            total = allMappings.length;
        }
        
        const mappings = await skuMapping.getAllSkuMappings(platform, search, parseInt(limit), parseInt(offset));
        
        res.json({
            success: true,
            mappings,
            total,
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
    } catch (error) {
        console.error('Error getting SKU mappings:', error);
        res.status(500).json({ error: error.message });
    }
});

// Test endpoint for getting inventory with FBA inventory (no auth required)
app.get('/api/test/inventory-with-fba', async (req, res) => {
    console.log('Test endpoint: Fetching inventory items with FBA inventory...');
    try {
        const query = `
            SELECT 
                ii.id,
                ii.sku,
                ii.name,
                ii.type,
                ii.stock_level,
                ii.fba_inventory,
                ii.fba_available,
                ii.fba_inbound,
                ii.fba_reserved,
                ii.fba_unfulfillable,
                ii.fba_asin,
                ii.last_fba_update,
                json_build_object(
                    'total', COALESCE(ii.fba_inventory, 0),
                    'available', COALESCE(ii.fba_available, 0),
                    'inbound', COALESCE(ii.fba_inbound, 0),
                    'reserved', COALESCE(ii.fba_reserved, 0),
                    'unfulfillable', COALESCE(ii.fba_unfulfillable, 0),
                    'asin', ii.fba_asin,
                    'condition', ii.fba_condition,
                    'product_name', ii.fba_product_name,
                    'last_update', ii.last_fba_update
                ) as fba_details
            FROM InventoryItems ii
            WHERE ii.fba_inventory > 0
            ORDER BY ii.fba_inventory DESC
        `;
        
        const result = await pgPool.query(query);
        res.json({
            success: true,
            count: result.rows.length,
            items: result.rows
        });
    } catch (error) {
        console.error('Error fetching inventory with FBA:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ... existing code ...

// API endpoint to update FBA inventory for a single SKU
app.post('/api/v1/sync/fba-inventory/:sku', async (req, res) => {
    try {
        console.log(`Updating FBA inventory for SKU ${req.params.sku}`);
        const AmazonAPI = require('./amazon');
        const amazonClient = new AmazonAPI();
        const skuMapping = require('./mapping');

        // Get the Amazon SKU for this internal SKU
        const mappings = await skuMapping.getAllSkuMappings('amazon', req.params.sku);
        const mapping = mappings.find(m => m.internal_sku === req.params.sku);

        if (!mapping) {
            return res.status(404).json({
                success: false,
                message: 'No Amazon SKU mapping found for this internal SKU'
            });
        }

        const result = await amazonClient.updateSingleFbaInventory(req.params.sku, mapping.platform_sku);
        
        if (result.success) {
            res.json({ 
                success: true, 
                message: `Successfully updated FBA inventory for ${req.params.sku}`,
                fba_inventory: result
            });
        } else {
            res.status(500).json({
                success: false,
                message: result.message || 'Failed to update FBA inventory',
                error: result.error
            });
        }
    } catch (error) {
        console.error('Error updating FBA inventory:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error updating FBA inventory', 
            error: error.message 
        });
    }
});

// ... existing code ...

// --- NEW Procurement Suggestions Endpoint ---
app.get('/api/procurement', authenticateToken, checkPermission('view_procurement'), async (req, res) => {
    console.log('[Procurement API] Request received.');
    try {
        // Query to get non-finished goods inventory, their stock, minimum levels, and vendor name
        const query = `
            SELECT 
                ii.sku,
                ii.name,
                ii.type,
                COALESCE(ii.minimum_quantity, 0) as minimum_stock_level, -- Use correct column name, treat NULL as 0
                s.name as vendor_name, -- Get vendor name from suppliers table
                CASE 
                    WHEN COUNT(ib.id) > 0 THEN COALESCE(SUM(ib.stock_level), 0)
                    ELSE COALESCE(ii.stock_level, 0)
                END as current_stock
            FROM inventoryitems ii -- Use lowercase table name
            LEFT JOIN inventorybatches ib ON ii.id = ib.inventory_item_id -- Use lowercase table name
            LEFT JOIN suppliers s ON ii.supplier_id = s.id -- Join with suppliers table
            WHERE LOWER(ii.type) != 'finished good' -- Exclude Finished Goods
            GROUP BY ii.id, ii.sku, ii.name, ii.type, ii.minimum_quantity, s.name -- Group by correct columns, include vendor name
            ORDER BY ii.type, ii.name;
        `;

        const { rows: allItems } = await pgPool.query(query);
        console.log(`[Procurement API] Fetched ${allItems.length} non-finished goods items.`);

        const procurementItems = allItems.map(item => {
            const currentStock = Number(item.current_stock || 0);
            const minStock = Number(item.minimum_stock_level || 0); // This uses the aliased name from the query
            let suggestedOrderQty = 0;

            // Basic calculation: order if below minimum (and minimum is > 0)
            if (minStock > 0 && currentStock < minStock) { // Only suggest if minStock is actually set (> 0)
                suggestedOrderQty = minStock - currentStock; 
                // TODO: Add buffer? Use default reorder qty? Round to case size?
            }
            
            // Add placeholder for projected usage
            item.projected_usage = 'N/A'; // Placeholder - complex calculation needed later
            item.vendor = item.vendor_name || 'N/A'; // Use vendor name from query, default if NULL
            item.suggested_order_qty = suggestedOrderQty;
            item.current_stock = currentStock; // Ensure it's a number
            item.min_stock = minStock; // Use consistent key name with frontend
            
            // Remove the original vendor_name field after using it
            delete item.vendor_name; 

            return item;

        }).filter(item => item.suggested_order_qty > 0); // Only return items needing procurement

        console.log(`[Procurement API] Found ${procurementItems.length} items needing procurement.`);

        res.json({ procurementItems });

    } catch (error) {
        console.error('[Procurement API] Error fetching procurement data:', error.message);
        console.error(error.stack); 
        res.status(500).json({ error: 'Failed to fetch procurement suggestions.', details: error.message });
    }
});

// --- NEW Enhanced Procurement Suggestions Endpoint (MMR Driven) ---
app.get('/api/procurement/mmr', authenticateToken, checkPermission('view_procurement'), async (req, res) => {
    console.log('[Procurement API] Request received (MMR Driven).');
    const client = await pgPool.connect();
    try {
        await client.query('BEGIN'); // Start transaction

        // --- 1. Calculate Production Needs for Finished Goods --- 

        // Get all Finished Goods
        const fgResult = await client.query(`
            SELECT id, sku, name, COALESCE(stock_level, 0) as current_stock, COALESCE(minimum_quantity, 0) as minimum_quantity 
            FROM inventoryitems 
            WHERE LOWER(type) = 'finished good'
        `);
        const finishedGoods = fgResult.rows;
        console.log(`[Procurement API] Found ${finishedGoods.length} finished goods.`);

        // Calculate 90-day average daily sales for forecast (Assuming 'saleshistory' table)
        // In a real scenario, this might use a more sophisticated forecast model or existing forecast data.
        const ninetyDaysAgo = new Date();
        ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

        // Corrected query using salesorders and salesorderitems
        const salesResult = await client.query(` 
            SELECT soi.product_sku as sku, SUM(soi.quantity) as total_quantity
            FROM salesorderitems soi
            JOIN salesorders so ON soi.sales_order_id = so.id
            WHERE so.order_date >= $1 AND soi.product_sku = ANY($2::text[])
            GROUP BY soi.product_sku
        `, [ninetyDaysAgo, finishedGoods.map(fg => fg.sku)]);
        
        const salesMap = salesResult.rows.reduce((map, row) => {
            map[row.sku] = row.total_quantity; // Keep using row.sku as it's aliased in the query
            return map;
        }, {});

        const productionNeeds = {}; // Store FG SKU -> quantity needed
        for (const fg of finishedGoods) {
            const totalSales90d = Number(salesMap[fg.sku] || 0);
            const avgDailySales = totalSales90d / 90;
            const forecastDemand30d = Math.ceil(avgDailySales * 30); // Forecast for next 30 days
            
            const currentStock = Number(fg.current_stock);
            const minStock = Number(fg.minimum_quantity);

            // Calculate how many units need to be produced
            const needed = Math.max(0, forecastDemand30d + minStock - currentStock);
            
            if (needed > 0) {
                productionNeeds[fg.sku] = Math.ceil(needed); // Round up needed production
                console.log(`[Procurement API] FG ${fg.sku}: Forecast30d=${forecastDemand30d.toFixed(2)}, Current=${currentStock}, Min=${minStock} => Production Needed=${productionNeeds[fg.sku]}`);
            } else {
                 console.log(`[Procurement API] FG ${fg.sku}: Forecast30d=${forecastDemand30d.toFixed(2)}, Current=${currentStock}, Min=${minStock} => No Production Needed.`);
            }
        }

        // --- 2. Calculate Aggregate Component Demand based on Production Needs and MMRs ---

        const componentDemand = {}; // Store Component SKU -> total quantity needed

        for (const fgSku in productionNeeds) {
            const productionQty = productionNeeds[fgSku];
            if (productionQty <= 0) continue;

            // Find the latest active MMR for this FG
            const mmrResult = await client.query(`
                SELECT product_sku, version, base_quantity 
                FROM mmrs 
                WHERE product_sku = $1 AND is_active = true 
                ORDER BY version DESC 
                LIMIT 1
            `, [fgSku]);

            if (mmrResult.rows.length === 0) {
                console.log(`[Procurement API] No active MMR found for FG ${fgSku}, skipping component calculation.`);
                continue;
            }
            const mmr = mmrResult.rows[0];
            const mmrBaseQty = Number(mmr.base_quantity || 1); // Avoid division by zero

            console.log(`[Procurement API] Using MMR ${mmr.product_sku} v${mmr.version} (Base Qty: ${mmrBaseQty}) for ${productionQty} units.`);

            // Get components (ingredients, packaging, labels)
            const ingredientsResult = await client.query(`SELECT ingredient_sku as sku, quantity FROM mmringredients WHERE mmr_product_sku = $1 AND mmr_version = $2`, [mmr.product_sku, mmr.version]);
            const packagingResult = await client.query(`SELECT packaging_sku as sku, quantity FROM mmrpackaging WHERE mmr_product_sku = $1 AND mmr_version = $2`, [mmr.product_sku, mmr.version]);
            const labelsResult = await client.query(`SELECT label_sku as sku, quantity FROM mmrlabels WHERE mmr_product_sku = $1 AND mmr_version = $2`, [mmr.product_sku, mmr.version]);
            
            const allComponents = [...ingredientsResult.rows, ...packagingResult.rows, ...labelsResult.rows];

            // Calculate and aggregate demand for each component
            for (const component of allComponents) {
                const componentQtyPerMmrBase = Number(component.quantity || 0);
                const componentQtyPerFgUnit = componentQtyPerMmrBase / mmrBaseQty;
                const totalComponentNeeded = componentQtyPerFgUnit * productionQty;

                componentDemand[component.sku] = (componentDemand[component.sku] || 0) + totalComponentNeeded;
                 console.log(`   [Procurement API] Component ${component.sku}: Needs ${totalComponentNeeded.toFixed(2)} (MMR Qty: ${componentQtyPerMmrBase}, Rate: ${componentQtyPerFgUnit.toFixed(4)})`);
            }
        }
        console.log('[Procurement API] Aggregated Component Demand:', componentDemand);

        // --- 3. Get Current State of Procurement Items (Non-Finished Goods) ---
        const itemsResult = await client.query(`
            SELECT 
                ii.id,
                ii.sku,
                ii.name,
                ii.type,
                COALESCE(ii.minimum_quantity, 0) as minimum_quantity,
                s.name as vendor_name,
                -- Calculate current stock (sum of batches if exist, else item level)
                COALESCE((SELECT SUM(stock_level) FROM inventorybatches ib WHERE ib.inventory_item_id = ii.id), ii.stock_level, 0) as current_stock
            FROM inventoryitems ii
            LEFT JOIN suppliers s ON ii.supplier_id = s.id
            WHERE LOWER(ii.type) != 'finished good'
            ORDER BY ii.type, ii.name;
        `);
        const allItems = itemsResult.rows;
        console.log(`[Procurement API] Fetched ${allItems.length} non-finished goods items for suggestion calculation.`);

        // --- 4. Calculate Final Suggestions ---
        const procurementItems = allItems.map(item => {
            const currentStock = Number(item.current_stock || 0);
            const minStock = Number(item.minimum_quantity || 0);
            const projectedUsage = Math.ceil(componentDemand[item.sku] || 0); // Round up projected usage

            // Calculate suggested order quantity 
            const suggestedOrderQty = Math.max(0, projectedUsage + minStock - currentStock);
            
            return {
                sku: item.sku,
                name: item.name,
                type: item.type,
                vendor: item.vendor_name || 'N/A',
                current_stock: currentStock,
                min_stock: minStock, // Renamed for consistency with frontend
                projected_usage: projectedUsage, // Add calculated projected usage
                suggested_order_qty: Math.ceil(suggestedOrderQty) // Round up final suggestion
            };
        }).filter(item => item.suggested_order_qty > 0); // Only return items needing procurement

        console.log(`[Procurement API] Found ${procurementItems.length} items needing procurement after MMR calculation.`);

        await client.query('COMMIT'); // Commit transaction
        res.json({ procurementItems });

    } catch (error) {
        await client.query('ROLLBACK'); // Rollback on error
        console.error('[Procurement API - MMR Driven] Error fetching procurement data:', error.message);
        console.error(error.stack); 
        res.status(500).json({ error: 'Failed to fetch procurement suggestions.', details: error.message });
    } finally {
        client.release(); // Release client connection
    }
});

// --- END of Procurement Endpoint ---

// Existing /api/inventory/search endpoint ...
// ... existing code ...

// Update inventory item status (activate/deactivate)
app.patch('/api/inventory/:sku/status', authenticateToken, checkPermission('edit_inventory'), async (req, res) => {
    const { sku } = req.params;
    const { is_active } = req.body; // Expecting { "is_active": boolean }

    if (typeof is_active !== 'boolean') {
        return res.status(400).json({ error: 'Invalid request body. "is_active" (boolean) is required.' });
    }

    try {
        const result = await pgPool.query(
            'UPDATE InventoryItems SET is_active = $1, updated_at = CURRENT_TIMESTAMP WHERE sku = $2 RETURNING *',
            [is_active, sku]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Item not found' });
        }

        console.log(`Inventory item ${sku} status updated to is_active=${is_active}`);
        res.json({ success: true, item: result.rows[0] });
    } catch (err) {
        console.error(`Error updating status for inventory item ${sku}:`, err);
        res.status(500).json({ error: 'Failed to update item status', details: err.message });
    }
});

// Delete inventory item by SKU
// ... existing code ...

// Get production orders endpoint
app.get('/api/v1/production-orders', authenticateToken, async (req, res) => {
    console.log('Production orders endpoint called');
    const { page = 1, limit = 10, status, sort_by, sort_dir } = req.query;
    
    try {
        // Build the query
        let query = `
            SELECT po.*, m.base_quantity 
            FROM ProductionOrders po
            LEFT JOIN MMRs m ON po.mmr_product_sku = m.product_sku AND po.mmr_version = m.version
            WHERE 1=1
        `;
        
        const queryParams = [];
        let paramIndex = 1;
        
        // Add status filter if provided
        if (status) {
            query += ` AND po.status = $${paramIndex}`;
            queryParams.push(status);
            paramIndex++;
        }
        
        // Add sorting
        const validSortFields = ['id', 'product_sku', 'quantity', 'status', 'created_at', 'due_date', 'finished_batch_number'];
        const sortField = validSortFields.includes(sort_by) ? sort_by : 'id';
        const sortDirection = sort_dir === 'asc' ? 'ASC' : 'DESC';
        
        query += ` ORDER BY po.${sortField} ${sortDirection}`;
        
        // Add pagination
        const offset = (parseInt(page) - 1) * parseInt(limit);
        query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        queryParams.push(parseInt(limit), offset);
        
        // Execute the query
        const result = await pgPool.query(query, queryParams);
        
        // Get the total count for pagination
        const countQuery = `
            SELECT COUNT(*) FROM ProductionOrders po
            WHERE 1=1 ${status ? ' AND po.status = $1' : ''}
        `;
        const countResult = await pgPool.query(countQuery, status ? [status] : []);
        const totalCount = parseInt(countResult.rows[0].count);
        
        res.json({
            orders: result.rows,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(totalCount / parseInt(limit)),
                limit: parseInt(limit),
                totalItems: totalCount
            }
        });
    } catch (error) {
        console.error('Error fetching production orders:', error);
        res.status(500).json({ 
            error: 'Failed to fetch production orders',
            details: error.message
        });
    }
});

// Get a single production order by ID
app.get('/api/v1/production-orders/:id', authenticateToken, async (req, res) => {
    const orderId = req.params.id;
    console.log(`Fetching production order details for ID: ${orderId}`);
    
    try {
        // Get the production order details
        const orderResult = await pgPool.query(`
            SELECT po.*, m.base_quantity 
            FROM ProductionOrders po
            LEFT JOIN MMRs m ON po.mmr_product_sku = m.product_sku AND po.mmr_version = m.version
            WHERE po.id = $1
        `, [orderId]);
        
        if (orderResult.rows.length === 0) {
            return res.status(404).json({ error: 'Production order not found' });
        }
        
        const order = orderResult.rows[0];
        
        // Get the ingredients and other materials used
        const batchesResult = await pgPool.query(`
            SELECT pb.*, ii.sku as item_sku, ii.name as item_name, ii.unit_type as inventory_unit, 
                   mi.unit_type as original_unit, mi.quantity as recipe_quantity
            FROM ProductionBatches pb
            JOIN InventoryItems ii ON pb.item_id = ii.id
            LEFT JOIN MMRIngredients mi ON (ii.sku = mi.ingredient_sku AND mi.mmr_product_sku = $1 AND mi.mmr_version = $2)
            WHERE pb.production_order_id = $3
        `, [order.mmr_product_sku, order.mmr_version, orderId]);
        
        // Get the equipment needed
        const equipmentResult = await pgPool.query(`
            SELECT equipment_name
            FROM MMREquipment
            WHERE mmr_product_sku = $1 AND mmr_version = $2
        `, [order.mmr_product_sku, order.mmr_version]);
        
        // Create a response with all the details
        const response = {
            ...order,
            batches_used: batchesResult.rows.map(batch => ({
                ...batch,
                conversion_factor: 1,  // Default to 1 if no unit conversion needed
                original_unit: batch.original_unit || batch.inventory_unit
            })),
            mmr_equipment: equipmentResult.rows.map(eq => eq.equipment_name)
        };
        
        res.json(response);
    } catch (error) {
        console.error('Error fetching production order details:', error);
        res.status(500).json({ 
            error: 'Failed to fetch production order details',
            details: error.message
        });
    }
});

// Update a production order's status
app.patch('/api/v1/production-orders/:id/status', authenticateToken, async (req, res) => {
    const orderId = req.params.id;
    const { status } = req.body;
    
    // Validate status
    const validStatuses = ['Pending', 'In Progress', 'Completed', 'Cancelled'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ 
            error: 'Invalid status', 
            message: `Status must be one of: ${validStatuses.join(', ')}`
        });
    }
    
    try {
        // First check if the order exists
        const checkResult = await pgPool.query('SELECT id FROM ProductionOrders WHERE id = $1', [orderId]);
        
        if (checkResult.rows.length === 0) {
            return res.status(404).json({ error: 'Production order not found' });
        }
        
        // Update the status
        const result = await pgPool.query(
            'UPDATE ProductionOrders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
            [status, orderId]
        );
        
        if (status === 'Completed') {
            // Add logic here to handle inventory adjustments on completion if needed
            console.log(`Production order ${orderId} marked as completed`);
        }
        
        res.json({ 
            success: true, 
            message: `Production order status updated to ${status}`,
            order: result.rows[0]
        });
    } catch (error) {
        console.error('Error updating production order status:', error);
        res.status(500).json({ 
            error: 'Failed to update production order status',
            details: error.message
        });
    }
});

// Test endpoint for FBA inventory sync without authentication (for debugging)
app.get('/api/test/fba-inventory', async (req, res) => {
    console.log('Test endpoint: Testing FBA inventory...');
    try {
        const client = await pgPool.connect();
        try {
            // Check if fba_inventory column exists
            const columnCheckResult = await client.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name='inventoryitems' AND column_name='fba_inventory'
            `);
            
            if (columnCheckResult.rows.length === 0) {
                // Add fba_inventory column if it doesn't exist
                await client.query(`ALTER TABLE InventoryItems ADD COLUMN IF NOT EXISTS fba_inventory INT DEFAULT 0`);
                await client.query(`ALTER TABLE InventoryItems ADD COLUMN IF NOT EXISTS last_fba_update TIMESTAMP`);
                console.log('Added FBA inventory columns to database');
            }
            
            // Update a few items with test FBA inventory data
            await client.query(`
                UPDATE InventoryItems 
                SET fba_inventory = CASE
                    WHEN sku = 'P-1001' THEN 50
                    WHEN sku = 'P-1002' THEN 25
                    WHEN sku = 'P-1003' THEN 10
                    ELSE FLOOR(RANDOM() * 20)::INT
                END,
                last_fba_update = CURRENT_TIMESTAMP
                WHERE type = 'finished good'
            `);
            
            // Get the updated items
            const result = await client.query(`
                SELECT sku, name, fba_inventory, last_fba_update 
                FROM InventoryItems 
                WHERE fba_inventory > 0
                ORDER BY fba_inventory DESC
            `);
            
            res.json({
                success: true,
                message: 'Test FBA inventory data added',
                items: result.rows
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error in test FBA endpoint:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get all MMRs for a specific product
app.get('/api/mmr/:product_sku', authenticateToken, async (req, res) => {
    try {
        const productSku = req.params.product_sku;
        console.log(`Fetching all MMRs for product: ${productSku}`);
        
        // Get all MMRs for this product
        const result = await pgPool.query(`
            SELECT * FROM MMRs 
            WHERE product_sku = $1 AND is_active = true
            ORDER BY version DESC
        `, [productSku]);
        
        console.log(`Found ${result.rowCount} MMRs for product ${productSku}`);
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching MMRs for product:', err);
        res.status(500).json({ error: err.message });
    }
});

// Debug endpoint to get all MMRs for a product (no auth required)
app.get('/api/debug/mmr/:product_sku', async (req, res) => {
    try {
        const productSku = req.params.product_sku;
        console.log(`DEBUG: Fetching all MMRs for product: ${productSku}`);
        
        // Get all MMRs for this product
        const result = await pgPool.query(`
            SELECT * FROM MMRs 
            WHERE product_sku = $1 AND is_active = true
            ORDER BY version DESC
        `, [productSku]);
        
        console.log(`DEBUG: Found ${result.rowCount} MMRs for product ${productSku}`);
        res.json(result.rows);
    } catch (err) {
        console.error('DEBUG ERROR: Error fetching MMRs for product:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/mmr/:product_sku/latest', async (req, res) => {
    try {
        const productSku = req.params.product_sku;
        console.log(`Fetching latest MMR for product: ${productSku}`);
        
        // Get the latest MMR for this product
        const result = await pgPool.query(`
            SELECT * FROM MMRs 
            WHERE product_sku = $1 AND is_active = true
            ORDER BY version DESC
            LIMIT 1
        `, [productSku]);
        
        console.log(`Found ${result.rowCount} MMR for product ${productSku}`);
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error fetching latest MMR:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get production orders by status
app.get('/api/v1/production-orders/status/:status', authenticateToken, async (req, res) => {
    const status = req.params.status;
    console.log(`Fetching production orders with status: ${status}`);
    console.log(`User requesting data: ${req.user ? req.user.username : 'Unknown'} (${req.user ? req.user.userId : 'no ID'})`);
    
    // Basic validation of status parameter
    const allowedStatuses = ['Pending', 'In Progress', 'Completed', 'Hold', 'Cancelled'];
    if (!allowedStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status value' });
    }

    try {
        // Updated query to join with test reports and aggregate them
        const query = `
            SELECT 
                po.*, 
                ii.name as product_name,
                COALESCE(
                    json_agg(
                        json_build_object(
                            'id', potr.id,
                            'filename', potr.filename,
                            'original_filename', potr.original_filename,
                            'uploaded_at', potr.uploaded_at
                        )
                    ) FILTER (WHERE potr.id IS NOT NULL), '[]'::json
                ) as test_reports
            FROM public.productionorders po
            LEFT JOIN public.inventoryitems ii ON po.product_sku = ii.sku
            LEFT JOIN public.productionordertestreports potr ON po.id = potr.production_order_id
            WHERE po.status = $1
            GROUP BY po.id, ii.id  -- Group by the primary keys
            ORDER BY po.id DESC; -- Or any other desired order
        `;
        
        console.log('Running SQL query:', query.replace(/\s+/g, ' ').trim());
        const result = await pgPool.query(query, [status]);
        
        // Log the results, including test_reports info
        console.log(`Found ${result.rows.length} production orders with status: ${status}`);
        result.rows.forEach(row => {
            if (row.id === 61) { // Only log details for order 61 to avoid too much output
                console.log(`Order #${row.id} test_reports:`, 
                    Array.isArray(row.test_reports) ? 
                    `${row.test_reports.length} reports` : 
                    `Not an array: ${typeof row.test_reports}`);
            }
        });
        
        res.json(result.rows); // Send the orders array directly

    } catch (err) {
        console.error('Error fetching production orders by status:', err);
        res.status(500).json({ error: 'Failed to fetch production orders', details: err.message });
    }
});

// Get production order report (BPR)
app.get('/api/v1/production-orders/:id/report', authenticateToken, async (req, res) => {
    const { id } = req.params;
    console.log(`Generating report for production order: ${id}`);
    
    try {
        // Order Details
        const orderResult = await pgPool.query(`
            SELECT po.*, ii.name as product_name 
            FROM ProductionOrders po
            LEFT JOIN InventoryItems ii ON po.product_sku = ii.sku
            WHERE po.id = $1
        `, [id]);
        
        if (orderResult.rows.length === 0) {
            return res.status(404).json({ error: 'Production order not found' });
        }
        
        const order = orderResult.rows[0];
        
        // Batches Used (Ingredients, Packaging, Labels)
        const batchesResult = await pgPool.query(`
            SELECT pb.*, ii.name, ii.unit_type, ii.sku as item_sku, ii.supplier_id, ii.type as item_type,
                   s.name as supplier_name
            FROM ProductionBatches pb
            LEFT JOIN InventoryItems ii ON pb.item_id = ii.id
            LEFT JOIN Suppliers s ON ii.supplier_id = s.id
            WHERE pb.production_order_id = $1
        `, [id]);
        
        // Production Steps
        const stepsResult = await pgPool.query(`
            SELECT ps.*
            FROM ProductionSteps ps
            WHERE ps.production_order_id = $1
            ORDER BY ps.step_number
        `, [id]);
        
        // Get MMR substeps directly from mmrsubsteps table
        const mmrSubstepsResult = await pgPool.query(`
            SELECT mss.*
            FROM mmrsubsteps mss
            WHERE mss.mmr_product_sku = $1 AND mss.mmr_version = $2
            ORDER BY mss.main_step_number, mss.sub_step_number
        `, [order.mmr_product_sku, order.mmr_version]);
        
        // Equipment Used
        const equipmentResult = await pgPool.query(`
            SELECT DISTINCT me.equipment_name
            FROM MMREquipment me
            JOIN ProductionOrders po ON me.mmr_product_sku = po.mmr_product_sku AND me.mmr_version = po.mmr_version
            WHERE po.id = $1
        `, [id]);
        
        // Process steps and associate subSteps with their parent steps
        const processedSteps = stepsResult.rows.map(step => {
            // Find subSteps that belong to this step's number 
            const matchingSubSteps = mmrSubstepsResult.rows.filter(
                subStep => subStep.main_step_number === step.step_number
            );
            
            // Convert to the expected format
            const formattedSubSteps = matchingSubSteps.map(subStep => ({
                sub_step_number: subStep.sub_step_number,
                description: subStep.description, 
                step_type: subStep.step_type,
                completed: false  // Default to false since we don't track completion for sub-steps yet
            }));
            
            // Return step with associated sub-steps
            return {
                ...step,
                sub_steps: formattedSubSteps
            };
        });
        
        // Construct report object
        const report = {
            order_details: {
                id: order.id,
                product_sku: order.product_sku,
                product_name: order.product_name || 'Unknown Product',
                batch_number: order.batch_number || order.finished_batch_number || 'N/A',
                production_date: order.created_at,
                completion_date: order.completed_at,
                status: order.status
            },
            batches_used: batchesResult.rows.map(batch => ({
                item_type: batch.item_type || 'raw_ingredient',
                name: batch.name || batch.item_sku,
                sku: batch.item_sku,
                quantity_used: batch.quantity_used,
                batch_number: batch.batch_number || 'N/A',
                supplier_name: batch.supplier_name || 'Unknown',
                unit_type: batch.unit_type || 'units'
            })),
            production_details: {
                quantity_produced: order.actual_yield || order.quantity || 0,
                equipment_used: equipmentResult.rows.map(eq => eq.equipment_name),
                steps: processedSteps
            },
            yield_data: {
                total_good_units: order.actual_yield || 0,
                rejected_units: order.rejected_units || 0,
                yield_percentage: order.actual_yield ? 
                    Math.round((order.actual_yield / order.quantity) * 100) : 100
            }
        };
        
        res.json(report);
    } catch (error) {
        console.error('Error generating production report:', error);
        res.status(500).json({ 
            error: 'Failed to generate production report',
            details: error.message 
        });
    }
});

// Setup upload directory for test reports
const uploadDir = path.join(__dirname, 'uploads', 'test_reports');
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir, { recursive: true });
    console.log(`Created upload directory: ${uploadDir}`);
}

// Configure Multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir); // Save files to the designated directory
  },
  filename: function (req, file, cb) {
    // Create a unique filename: timestamp + original filename
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const extension = path.extname(file.originalname);
    cb(null, file.fieldname + '-' + uniqueSuffix + extension);
  }
});

const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
            cb(null, true); // Accept PDF files
        } else {
            cb(new Error('Invalid file type, only PDF is allowed!'), false); // Reject other types
        }
    },
    limits: { fileSize: 10 * 1024 * 1024 } // Limit file size to 10MB
});

// --- Production Order Test Report Routes ---

// Endpoint to upload a test report PDF for a specific production order
app.post('/api/v1/production-orders/:id/report', authenticateToken, upload.single('reportFile'), async (req, res) => {
    const orderId = parseInt(req.params.id, 10);
    const userId = req.user.userId; // Assuming userId is available in req.user after authenticateToken

    if (isNaN(orderId)) {
        return res.status(400).json({ error: 'Invalid Production Order ID' });
    }

    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded or invalid file type (PDF required).' });
    }

    const { filename, originalname, path: filePath, mimetype } = req.file;

    // Basic security check: ensure the resolved path is within the intended upload directory
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(path.resolve(uploadDir))) {
         console.error(`Attempt to access file outside upload directory: ${resolvedPath}`);
         // Clean up the potentially misplaced file
         try { await fs.promises.unlink(filePath); } catch (unlinkErr) { console.error('Error cleaning up misplaced file:', unlinkErr); }
         return res.status(400).json({ error: 'Invalid file path detected.' });
    }


    const client = await pgPool.connect();
    try {
        // Verify the production order exists
        const orderCheck = await client.query('SELECT id FROM ProductionOrders WHERE id = $1', [orderId]);
        if (orderCheck.rows.length === 0) {
            // Clean up uploaded file if order doesn't exist
            try { await fs.promises.unlink(filePath); } catch (unlinkErr) { console.error('Error cleaning up file for non-existent order:', unlinkErr); }
            return res.status(404).json({ error: 'Production Order not found' });
        }

        // Insert report metadata into the database
        const insertResult = await client.query(
            `INSERT INTO public.productionordertestreports
             (production_order_id, filename, original_filename, file_path, mime_type, uploaded_by_user_id)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, filename, original_filename, uploaded_at`,
            [orderId, filename, originalname, filePath, mimetype, userId]
        );

        console.log(`Test report ${filename} uploaded for order ${orderId} by user ${userId}`);
        res.status(201).json({
            message: 'Test report uploaded successfully',
            report: insertResult.rows[0]
        });

    } catch (err) {
        console.error('Error uploading test report:', err);
        // Clean up uploaded file in case of database error
        try { await fs.promises.unlink(filePath); } catch (unlinkErr) { console.error('Error cleaning up file after DB error:', unlinkErr); }
        res.status(500).json({ error: 'Failed to upload test report', details: err.message });
    } finally {
        client.release();
    }
});


// Existing route (e.g., GET /api/v1/production-orders/status/:status) will be modified later...
// New routes for listing and serving files will be added next...

// Endpoint to list test reports for a specific production order
app.get('/api/v1/production-orders/:id/reports', authenticateToken, async (req, res) => {
    const orderId = parseInt(req.params.id, 10);

    if (isNaN(orderId)) {
        return res.status(400).json({ error: 'Invalid Production Order ID' });
    }

    try {
        const result = await pgPool.query(
            `SELECT id, filename, original_filename, uploaded_at, uploaded_by_user_id
             FROM public.productionordertestreports
             WHERE production_order_id = $1
             ORDER BY uploaded_at DESC`,
            [orderId]
        );

        res.json(result.rows);

    } catch (err) {
        console.error(`Error fetching test reports for order ${orderId}:`, err);
        res.status(500).json({ error: 'Failed to fetch test reports', details: err.message });
    }
});

// Endpoint to serve a specific test report file
app.get('/api/v1/production-orders/reports/:filename', authenticateToken, async (req, res) => {
    const filename = req.params.filename;

    // Basic filename validation to prevent path traversal
    if (!filename || filename.includes('..') || filename.includes('/')) {
        return res.status(400).json({ error: 'Invalid filename' });
    }

    try {
        const result = await pgPool.query(
            `SELECT file_path, mime_type, original_filename
             FROM public.productionordertestreports
             WHERE filename = $1`,
            [filename]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Report file not found' });
        }

        const report = result.rows[0];
        const filePath = report.file_path;
        
        // Check if file exists before attempting to send
        if (!fs.existsSync(filePath)) {
            console.error(`File not found on disk, but exists in DB: ${filePath}`);
            return res.status(404).json({ error: 'Report file not found on server' });
        }

        // Send the file, setting the Content-Disposition header to suggest the original filename
        res.setHeader('Content-Disposition', `inline; filename="${report.original_filename}"`)
        res.sendFile(filePath, { headers: { 'Content-Type': report.mime_type } }, (err) => {
            if (err) {
                console.error(`Error sending file ${filename}:`, err);
                // Avoid sending another response if headers were already sent
                if (!res.headersSent) {
                    res.status(500).send({ error: 'Failed to send file' });
                }
            }
        });

    } catch (err) {
        console.error(`Error retrieving report file ${filename}:`, err);
        res.status(500).json({ error: 'Failed to retrieve report file', details: err.message });
    }
});

// New endpoint to delete a test report by ID
app.delete('/api/v1/production-orders/report/:id', authenticateToken, async (req, res) => {
    const reportId = parseInt(req.params.id, 10);
    
    if (isNaN(reportId)) {
        return res.status(400).json({ error: 'Invalid report ID' });
    }
    
    const client = await pgPool.connect();
    try {
        // First get the file information
        const fileResult = await client.query(
            `SELECT file_path, original_filename
             FROM public.productionordertestreports
             WHERE id = $1`,
            [reportId]
        );
        
        if (fileResult.rows.length === 0) {
            return res.status(404).json({ error: 'Report not found' });
        }
        
        const filePath = fileResult.rows[0].file_path;
        const originalFilename = fileResult.rows[0].original_filename;
        
        // Delete from database
        await client.query(
            `DELETE FROM public.productionordertestreports
             WHERE id = $1`,
            [reportId]
        );
        
        // Delete the file from disk
        try {
            if (fs.existsSync(filePath)) {
                await fs.promises.unlink(filePath);
                console.log(`Deleted file from disk: ${filePath}`);
            } else {
                console.warn(`File not found on disk: ${filePath}`);
            }
        } catch (fileErr) {
            // Log error but don't fail the request if file deletion fails
            console.error(`Error deleting file ${filePath}:`, fileErr);
        }
        
        console.log(`Deleted test report #${reportId} (${originalFilename})`);
        res.status(200).json({ 
            message: 'Report deleted successfully', 
            id: reportId, 
            filename: originalFilename 
        });
        
    } catch (err) {
        console.error(`Error deleting report #${reportId}:`, err);
        res.status(500).json({ error: 'Failed to delete report', details: err.message });
    } finally {
        client.release();
    }
});

// Fetch production orders by status (e.g., 'Pending', 'Completed')
app.get('/api/v1/production-orders/status/:status', authenticateToken, async (req, res) => {
    const status = req.params.status;
    console.log(`Fetching production orders with status: ${status}`);
    
    // Basic validation of status parameter
    const allowedStatuses = ['Pending', 'In Progress', 'Completed', 'Hold', 'Cancelled'];
    if (!allowedStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status value' });
    }

    try {
        // Updated query to join with test reports and aggregate them
        const query = `
            SELECT 
                po.*, 
                ii.name as product_name,
                COALESCE(
                    json_agg(
                        json_build_object(
                            'id', potr.id,
                            'filename', potr.filename,
                            'original_filename', potr.original_filename,
                            'uploaded_at', potr.uploaded_at
                        )
                    ) FILTER (WHERE potr.id IS NOT NULL), '[]'::json
                ) as test_reports
            FROM public.productionorders po
            LEFT JOIN public.inventoryitems ii ON po.product_sku = ii.sku
            LEFT JOIN public.productionordertestreports potr ON po.id = potr.production_order_id
            WHERE po.status = $1
            GROUP BY po.id, ii.id  -- Group by the primary keys
            ORDER BY po.id DESC; -- Or any other desired order
        `;
        
        console.log('Running SQL query:', query.replace(/\s+/g, ' ').trim());
        const result = await pgPool.query(query, [status]);
        
        // Log the results, including test_reports info
        console.log(`Found ${result.rows.length} production orders with status: ${status}`);
        result.rows.forEach(row => {
            if (row.id === 61) { // Only log details for order 61 to avoid too much output
                console.log(`Order #${row.id} test_reports:`, 
                    Array.isArray(row.test_reports) ? 
                    `${row.test_reports.length} reports` : 
                    `Not an array: ${typeof row.test_reports}`);
            }
        });
        
        res.json(result.rows); // Send the orders array directly

    } catch (err) {
        console.error('Error fetching production orders by status:', err);
        res.status(500).json({ error: 'Failed to fetch production orders', details: err.message });
    }
});

// Fetch a single production order by ID
// ... existing code ...

// Endpoint to get BPR data for modal preview (Minor update: Fetch report paths)
app.get('/api/v1/production-orders/:id/report', authenticateToken, async (req, res) => {
    const orderId = parseInt(req.params.id, 10);
    if (isNaN(orderId)) {
        return res.status(400).json({ error: 'Invalid Order ID' });
    }

    const client = await pgPool.connect();
    try {
        console.log(`Fetching BPR preview data for order: ${orderId}`);
        // Fetch order details
        const orderResult = await client.query('SELECT * FROM ProductionOrders WHERE id = $1', [orderId]);
        if (orderResult.rows.length === 0) {
            return res.status(404).json({ error: 'Production Order not found' });
        }
        const orderDetails = orderResult.rows[0];

        // Fetch related data (batches, steps, etc.) - Simplified for brevity, assume this logic exists
        // Batches used (raw materials, packaging, labels)
        const batchesResult = await client.query(
            `SELECT pb.*, ii.name, ii.sku, ii.unit_type, s.name as supplier_name
             FROM ProductionBatches pb 
             JOIN InventoryItems ii ON pb.item_id = ii.id 
             LEFT JOIN Suppliers s ON ii.supplier_id = s.id
             WHERE pb.production_order_id = $1`,
            [orderId]
        );
        const batchesUsed = batchesResult.rows;

        // Production details (steps, yield)
        const stepsResult = await client.query(
            'SELECT * FROM ProductionSteps WHERE production_order_id = $1 ORDER BY step_number ASC', 
            [orderId]
        );
        const productionSteps = stepsResult.rows;
        
        // Fetch test report paths along with other details
        const reportsResult = await client.query(
            `SELECT id, filename, original_filename, file_path, uploaded_at 
             FROM public.productionordertestreports 
             WHERE production_order_id = $1 
             ORDER BY uploaded_at ASC`,
            [orderId]
        );
        const testReports = reportsResult.rows;

        // Construct the response object (similar to before, but now includes file_path)
        const reportData = {
            order_details: orderDetails,
            batches_used: batchesUsed,
            production_details: { 
                steps: productionSteps, 
                // Assuming quantity_produced, equipment_used etc. are derived or stored elsewhere
                quantity_produced: orderDetails.quantity, // Example placeholder
                equipment_used: [] // Example placeholder
            },
            yield_data: { 
                total_good_units: orderDetails.actual_yield, // Example placeholder
                // Other yield fields
            },
            test_reports: testReports // Include full report details
        };

        res.json(reportData);

    } catch (error) {
        console.error(`Error fetching BPR data for order ${orderId}:`, error);
        res.status(500).json({ error: 'Failed to fetch BPR data', details: error.message });
    } finally {
        client.release();
    }
});

// New Endpoint: Download Combined BPR and Test Reports PDF
app.get('/api/v1/production-orders/:id/download-combined-report', authenticateToken, async (req, res) => {
    const orderId = parseInt(req.params.id, 10);
    if (isNaN(orderId)) {
        return res.status(400).json({ error: 'Invalid Order ID' });
    }

    const client = await pgPool.connect();
    try {
        console.log(`Generating combined PDF for order: ${orderId}`);
        
        // --- 1. Fetch all necessary data (similar to /report endpoint) ---
        // Corrected Query: Join with InventoryItems to get product_name
        const orderResult = await client.query(`
            SELECT po.*, ii.name as product_name 
            FROM ProductionOrders po 
            LEFT JOIN InventoryItems ii ON po.product_sku = ii.sku 
            WHERE po.id = $1
        `, [orderId]);
        if (orderResult.rows.length === 0) {
            return res.status(404).json({ error: 'Production Order not found' });
        }
        const orderDetails = orderResult.rows[0];

        const batchesResult = await client.query(
            `SELECT pb.*, ii.name, ii.sku, ii.unit_type, s.name as supplier_name 
             FROM ProductionBatches pb JOIN InventoryItems ii ON pb.item_id = ii.id LEFT JOIN Suppliers s ON ii.supplier_id = s.id 
             WHERE pb.production_order_id = $1 ORDER BY ii.type, ii.name`, [orderId]
        );
        const batchesUsed = batchesResult.rows;

        // Corrected Query: Join ProductionSteps with ProductionOrders to get MMR info for joining with MMRSubSteps
        const stepsResult = await client.query(
            `SELECT ps.*, -- Select all columns from ProductionSteps
                    po.mmr_product_sku, po.mmr_version, -- Include MMR info from ProductionOrders
                    mss.description as sub_step_description, mss.sub_step_number, mss.step_type 
             FROM ProductionSteps ps 
             JOIN ProductionOrders po ON ps.production_order_id = po.id -- Join steps with orders
             LEFT JOIN MMRSubSteps mss ON po.mmr_product_sku = mss.mmr_product_sku -- Join substeps using po.mmr_...
                                      AND po.mmr_version = mss.mmr_version 
                                      AND ps.step_number = mss.main_step_number 
             WHERE ps.production_order_id = $1 
             ORDER BY ps.step_number ASC, mss.sub_step_number ASC`, 
            [orderId]
        );
        // Group sub-steps under main steps
        const productionSteps = stepsResult.rows.reduce((acc, row) => {
            let step = acc.find(s => s.step_number === row.step_number);
            if (!step) {
                step = { ...row, sub_steps: [] };
                delete step.sub_step_description; // Remove redundant fields
                delete step.sub_step_number;
                delete step.step_type;
                acc.push(step);
            }
            if (row.sub_step_number) { // If there's a sub-step
                step.sub_steps.push({ 
                    sub_step_number: row.sub_step_number, 
                    description: row.sub_step_description,
                    step_type: row.step_type,
                    // Include completion status for sub-steps if tracked separately
                });
            }
            return acc;
        }, []);

        const reportsResult = await client.query('SELECT file_path, original_filename FROM public.productionordertestreports WHERE production_order_id = $1 ORDER BY uploaded_at ASC', [orderId]);
        const testReportFiles = reportsResult.rows;

        // --- 2. Create a new PDF document using pdf-lib ---
        const combinedPdfDoc = await PDFDocument.create();
        const timesRomanFont = await combinedPdfDoc.embedFont(StandardFonts.TimesRoman);
        const timesRomanBoldFont = await combinedPdfDoc.embedFont(StandardFonts.TimesRomanBold);
        const pageMargin = 50;
        const contentWidth = 612 - 2 * pageMargin; // Standard US Letter width

        // --- 3. Generate BPR Pages on the Server ---
        let currentPage = combinedPdfDoc.addPage();
        let { width, height } = currentPage.getSize();
        let y = height - pageMargin;

        // Helper function to add text, handling wrapping and page breaks
        const addText = (text, size, font, indent = 0, isBold = false) => {
            const currentFont = isBold ? timesRomanBoldFont : timesRomanFont;
            const maxWidth = contentWidth - indent;
            const words = text.split(' ');
            let line = '';

            for (const word of words) {
                const testLine = line + (line ? ' ' : '') + word;
                const testWidth = currentFont.widthOfTextAtSize(testLine, size);

                if (testWidth <= maxWidth) {
                    line = testLine;
                } else {
                    // Draw the line that fits
                    if (y < pageMargin + size) { // Check space before drawing
                        currentPage = combinedPdfDoc.addPage();
                        y = height - pageMargin;
                    }
                    currentPage.drawText(line, {
                        x: pageMargin + indent,
                        y: y,
                        font: currentFont,
                        size: size,
                        color: rgb(0, 0, 0)
                    });
                    y -= (size * 1.2); // Line height approx 1.2x font size
                    line = word; // Start new line with the current word
                }
            }

            // Draw the last line
            if (line) {
                if (y < pageMargin + size) { // Check space before drawing
                    currentPage = combinedPdfDoc.addPage();
                    y = height - pageMargin;
                }
                currentPage.drawText(line, {
                    x: pageMargin + indent,
                    y: y,
                    font: currentFont,
                    size: size,
                    color: rgb(0, 0, 0)
                });
                y -= (size * 1.2);
            }
            y -= 5; // Add space after paragraph/section
        };

        // Function to draw a table
        const drawTable = (headers, rows, startY, options = {}) => {
            const {
                fontSize = 10,
                headerFontSize = 11,
                rowHeight = 20,
                colWidths = [],
                indent = 0,
                wrapColumns = [],
                highlightCondition = null // Function that returns true if row should be highlighted
            } = options;
            
            const tableWidth = contentWidth - (indent * 2);
            
            // Calculate column widths if not provided
            let calculatedColWidths = colWidths;
            if (colWidths.length === 0) {
                const colCount = headers.length;
                calculatedColWidths = Array(colCount).fill(tableWidth / colCount);
            }
            
            let currentY = startY;
            
            // Draw table headers
            let currentX = pageMargin + indent;
            
            // Draw header background
            currentPage.drawRectangle({
                x: currentX,
                y: currentY - rowHeight,
                width: tableWidth,
                height: rowHeight,
                color: rgb(0.9, 0.9, 0.9),
                borderWidth: 1,
                borderColor: rgb(0, 0, 0),
            });
            
            // Draw header text
            headers.forEach((header, idx) => {
                currentPage.drawText(header, {
                    x: currentX + 5, // 5px padding
                    y: currentY - rowHeight + 5, // 5px from bottom
                    font: timesRomanBoldFont,
                    size: headerFontSize,
                    color: rgb(0, 0, 0)
                });
                currentX += calculatedColWidths[idx];
            });
            
            currentY -= rowHeight;
            
            // Draw table rows
            rows.forEach((row, rowIdx) => {
                // Calculate row height based on content
                let dynamicRowHeight = rowHeight;
                
                // Check if any columns need wrapping and calculate required height
                wrapColumns.forEach(colIdx => {
                    if (colIdx < row.length) {
                        const cellText = String(row[colIdx] || '');
                        const maxWidth = calculatedColWidths[colIdx] - 10; // 5px padding on each side
                        const textWidth = timesRomanFont.widthOfTextAtSize(cellText, fontSize);
                        
                        if (textWidth > maxWidth) {
                            // Estimate lines needed
                            const linesNeeded = Math.ceil(textWidth / maxWidth);
                            const heightNeeded = linesNeeded * (fontSize * 1.2) + 10; // Add padding
                            
                            dynamicRowHeight = Math.max(dynamicRowHeight, heightNeeded);
                        }
                    }
                });
                
                // Check if we need a new page
                if (currentY - dynamicRowHeight < pageMargin) {
                    currentPage = combinedPdfDoc.addPage();
                    currentY = height - pageMargin;
                    
                    // Redraw headers on the new page
                    currentX = pageMargin + indent;
                    currentPage.drawRectangle({
                        x: currentX,
                        y: currentY - rowHeight,
                        width: tableWidth,
                        height: rowHeight,
                        color: rgb(0.9, 0.9, 0.9),
                        borderWidth: 1,
                        borderColor: rgb(0, 0, 0),
                    });
                    
                    headers.forEach((header, idx) => {
                        currentPage.drawText(header, {
                            x: currentX + 5,
                            y: currentY - rowHeight + 5,
                            font: timesRomanBoldFont,
                            size: headerFontSize,
                            color: rgb(0, 0, 0)
                        });
                        currentX += calculatedColWidths[idx];
                    });
                    
                    currentY -= rowHeight;
                }
                
                // Draw row background (alternate colors for readability)
                currentX = pageMargin + indent;
                let rowColor;
                
                // Check if this row should be highlighted
                if (highlightCondition && highlightCondition(row)) {
                    rowColor = rgb(0.8, 0.9, 1.0); // Light blue for highlighted rows
                } else {
                    rowColor = rowIdx % 2 === 0 ? rgb(1, 1, 1) : rgb(0.95, 0.95, 0.95);
                }
                
                currentPage.drawRectangle({
                    x: currentX,
                    y: currentY - dynamicRowHeight,
                    width: tableWidth,
                    height: dynamicRowHeight,
                    color: rowColor,
                    borderWidth: 1,
                    borderColor: rgb(0.8, 0.8, 0.8),
                });
                
                // Draw cell text
                row.forEach((cell, idx) => {
                    let cellText = String(cell || '');
                    const maxWidth = calculatedColWidths[idx] - 10; // 5px padding on each side
                    
                    // Handle text wrapping for designated columns
                    if (wrapColumns.includes(idx)) {
                        const words = cellText.split(' ');
                        let line = '';
                        let lineY = currentY - 15; // Start position for text
                        
                        for (const word of words) {
                            const testLine = line + (line ? ' ' : '') + word;
                            const testWidth = timesRomanFont.widthOfTextAtSize(testLine, fontSize);
                            
                            if (testWidth <= maxWidth) {
                                line = testLine;
                            } else {
                                // Draw current line
                                currentPage.drawText(line, {
                                    x: currentX + 5,
                                    y: lineY,
                                    font: timesRomanFont,
                                    size: fontSize,
                                    color: rgb(0, 0, 0)
                                });
                                lineY -= fontSize * 1.2; // Move down for next line
                                line = word; // Start new line with current word
                            }
                        }
                        
                        // Draw the last line
                        if (line) {
                            currentPage.drawText(line, {
                                x: currentX + 5,
                                y: lineY,
                                font: timesRomanFont,
                                size: fontSize,
                                color: rgb(0, 0, 0)
                            });
                        }
                    } else {
                        // Simple truncation with ellipsis if text is too long
                        if (timesRomanFont.widthOfTextAtSize(cellText, fontSize) > maxWidth) {
                            while (cellText.length > 1 && 
                                   timesRomanFont.widthOfTextAtSize(cellText + '...', fontSize) > maxWidth) {
                                cellText = cellText.slice(0, -1);
                            }
                            cellText += '...';
                        }
                        
                        // Center the text vertically in the cell
                        const cellCenterY = currentY - (dynamicRowHeight / 2) - (fontSize / 2);
                        
                        currentPage.drawText(cellText, {
                            x: currentX + 5,
                            y: cellCenterY,
                            font: timesRomanFont,
                            size: fontSize,
                            color: rgb(0, 0, 0)
                        });
                    }
                    
                    currentX += calculatedColWidths[idx];
                });
                
                currentY -= dynamicRowHeight;
            });
            
            return currentY;
        };

        // --- Add BPR Content using tables ---
        addText('Batch Production Record', 16, timesRomanBoldFont, 0, true);
        y -= 10;

        // Create identification information table
        addText('Identification Information', 14, timesRomanBoldFont, 0, true);
        y -= 10;
        
        const identificationHeaders = ['Item', 'Value'];
        const identificationRows = [
            ['Order ID', orderDetails.id],
            ['Product', `${orderDetails.product_name || orderDetails.product_sku} (SKU: ${orderDetails.product_sku})`],
            ['Target Quantity', orderDetails.quantity],
            ['Batch Number', orderDetails.finished_batch_number || 'N/A'],
            ['Production Date', orderDetails.created_at ? new Date(orderDetails.created_at).toLocaleDateString() : 'N/A'],
            ['Completion Date', orderDetails.completed_at ? new Date(orderDetails.completed_at).toLocaleDateString() : 'N/A']
        ];
        
        y = drawTable(
            identificationHeaders, 
            identificationRows, 
            y, 
            { 
                colWidths: [150, contentWidth - 150],
                indent: 0
            }
        );
        y -= 15; // Add some space after the table
        
        // Raw Materials Section with Table
        addText('Raw Materials Used', 14, timesRomanBoldFont, 0, true);
        y -= 10;
        
        const rawMaterials = batchesUsed.filter(b => b.item_type === 'raw_ingredient');
        if (rawMaterials.length > 0) {
            const rawMaterialHeaders = ['Material', 'SKU', 'Quantity', 'Batch #', 'Supplier'];
            const rawMaterialRows = rawMaterials.map(mat => [
                mat.name,
                mat.sku,
                `${mat.quantity_used} ${mat.unit_type}`,
                mat.batch_number || 'N/A',
                mat.supplier_name || 'N/A'
            ]);
            
            y = drawTable(
                rawMaterialHeaders,
                rawMaterialRows,
                y,
                {
                    colWidths: [contentWidth * 0.25, contentWidth * 0.15, contentWidth * 0.15, contentWidth * 0.15, contentWidth * 0.3]
                }
            );
        } else {
            addText('No raw materials recorded.', 10, timesRomanFont, 10);
            y -= 10;
        }
        y -= 15;
        
        // Production Steps Section with Table
        addText('Production Steps', 14, timesRomanBoldFont, 0, true);
        y -= 10;
        
        if (productionSteps.length > 0) {
            const stepsHeaders = ['Step #', 'Description', 'Completed By', 'Date', 'Notes'];
            const stepsRows = productionSteps.map(step => [
                step.step_number,
                step.description,
                step.completed_by || 'N/A',
                step.completed_at ? new Date(step.completed_at).toLocaleString() : 'N/A',
                step.notes || 'None'
            ]);
            
            y = drawTable(
                stepsHeaders,
                stepsRows,
                y,
                {
                    // Set wider column for description which needs wrapping
                    colWidths: [contentWidth * 0.1, contentWidth * 0.4, contentWidth * 0.15, contentWidth * 0.2, contentWidth * 0.15],
                    wrapColumns: [1, 4] // Allow description and notes columns to wrap
                }
            );
            
            // For each step with substeps, add a separate table
            productionSteps.forEach(step => {
                if (step.sub_steps && step.sub_steps.length > 0) {
                    if (y < pageMargin + 70) { // Ensure enough space for substep heading and table
                        currentPage = combinedPdfDoc.addPage();
                        y = height - pageMargin;
                    }
                    
                    y -= 15;
                    addText(`Sub-Steps for Step ${step.step_number}: ${step.description}`, 12, timesRomanBoldFont, 10, true);
                    y -= 10;
                    
                    const subStepHeaders = ['Sub-Step #', 'Description', 'Type'];
                    const subStepRows = step.sub_steps.map(sub => [
                        sub.sub_step_number,
                        sub.description,
                        sub.step_type === 'qc' ? 'QC Check' : 'Standard'
                    ]);
                    
                    y = drawTable(
                        subStepHeaders,
                        subStepRows,
                        y,
                        { 
                            indent: 10,
                            colWidths: [contentWidth * 0.15, contentWidth * 0.55, contentWidth * 0.2],
                            wrapColumns: [1], // Allow description column to wrap
                            highlightCondition: row => row[2] === 'QC Check' // Highlight QC rows
                        }
                    );
                }
            });
        } else {
            addText('No steps recorded.', 10, timesRomanFont, 10);
            y -= 10;
        }
        y -= 15;
        
        // Yield Data Section with Table
        addText('Yield Data', 14, timesRomanBoldFont, 0, true);
        y -= 10;
        
        const yieldHeaders = ['Metric', 'Value'];
        const yieldRows = [
            ['Target Quantity', orderDetails.quantity || 'N/A'],
            ['Actual Yield', orderDetails.actual_yield || 'N/A'],
            ['Yield Percentage', orderDetails.actual_yield && orderDetails.quantity 
                ? Math.round((orderDetails.actual_yield / orderDetails.quantity) * 100) + '%' 
                : 'N/A']
        ];
        
        y = drawTable(
            yieldHeaders,
            yieldRows,
            y,
            { 
                colWidths: [150, contentWidth - 150]
            }
        );
        y -= 15;

        // --- 4. Load and Append Test Report PDFs --- 
        for (const reportFile of testReportFiles) {
            try {
                const reportPdfBytes = await fsPromises.readFile(reportFile.file_path);
                const reportPdfDoc = await PDFDocument.load(reportPdfBytes, { 
                    // Ignore encryption if needed and permitted
                    // ignoreEncryption: true 
                });
                
                // Add a title page for the report (optional)
                const reportTitlePage = combinedPdfDoc.addPage();
                reportTitlePage.drawText(`Attached Test Report: ${reportFile.original_filename}`, { 
                    x: pageMargin, 
                    y: height - pageMargin,
                    font: timesRomanBoldFont,
                    size: 14 
                });

                // Copy pages from the test report to the combined document
                const copiedPages = await combinedPdfDoc.copyPages(reportPdfDoc, reportPdfDoc.getPageIndices());
                copiedPages.forEach((page) => combinedPdfDoc.addPage(page));
                console.log(`Appended report: ${reportFile.original_filename}`);
                
            } catch (pdfErr) {
                console.error(`Error processing test report PDF ${reportFile.original_filename} (${reportFile.file_path}):`, pdfErr);
                // Optionally add an error page to the combined PDF
                const errorPage = combinedPdfDoc.addPage();
                errorPage.drawText(`Error loading test report: ${reportFile.original_filename}`, { x: 50, y: height - 50, size: 12, color: rgb(1, 0, 0) });
                errorPage.drawText(`Details: ${pdfErr.message}`, { x: 50, y: height - 70, size: 10 });
            }
        }

        // --- 5. Serialize the combined PDF to bytes ---
        const combinedPdfBytes = await combinedPdfDoc.save();

        // --- 6. Send the combined PDF to the browser ---
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="Combined-BPR-Order-${orderId}.pdf"`);
        res.setHeader('Content-Length', combinedPdfBytes.length);
        res.end(Buffer.from(combinedPdfBytes)); // Send as Buffer

    } catch (error) {
        console.error(`Error generating combined PDF for order ${orderId}:`, error);
        // Avoid sending PDF headers if an error occurred before sending
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to generate combined PDF report', details: error.message });
        }
    } finally {
        client.release();
    }
});

// ... rest of index.js ...

// Add a debug endpoint to manually create the productionordertestreports table
app.get('/api/debug/create-test-reports-table', async (req, res) => {
  try {
    console.log('DEBUG: Creating productionordertestreports table...');
    
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS public.productionordertestreports (
        id SERIAL PRIMARY KEY,
        production_order_id INTEGER NOT NULL REFERENCES public.productionorders(id),
        filename VARCHAR(255) NOT NULL,
        original_filename VARCHAR(255) NOT NULL,
        file_path TEXT NOT NULL,
        mime_type VARCHAR(100) NOT NULL,
        uploaded_by_user_id INTEGER NOT NULL,
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(production_order_id, filename)
      )
    `);
    
    console.log('DEBUG: Successfully created productionordertestreports table');
    res.status(200).json({ success: true, message: 'Test reports table created successfully' });
  } catch (error) {
    console.error('DEBUG: Error creating test reports table:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// New Endpoint: Download Combined BPR and Test Reports PDF
app.get('/api/mmr/:product_sku/versions', authenticateToken, async (req, res) => {
    try {
        const productSku = req.params.product_sku;
        console.log(`Fetching MMR versions for product: ${productSku}`);
        
        // Get versions for this product
        const result = await pgPool.query(`
            SELECT version, created_at
            FROM MMRs 
            WHERE product_sku = $1 AND is_active = true
            ORDER BY version DESC
        `, [productSku]);
        
        console.log(`Found ${result.rowCount} MMR versions for product ${productSku}`);
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching MMR versions for product:', err);
        res.status(500).json({ error: err.message });
    }
});

// Debug endpoint to get all MMRs for a product (no auth required)
app.get('/api/debug/mmr/:product_sku', async (req, res) => {
    try {
        const productSku = req.params.product_sku;
        console.log(`DEBUG: Fetching all MMRs for product: ${productSku}`);
        
        // Get all MMRs for this product
        const result = await pgPool.query(`
            SELECT * FROM MMRs 
            WHERE product_sku = $1 AND is_active = true
            ORDER BY version DESC
        `, [productSku]);
        
        console.log(`DEBUG: Found ${result.rowCount} MMRs for product ${productSku}`);
        res.json(result.rows);
    } catch (err) {
        console.error('DEBUG ERROR: Error fetching MMRs for product:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get all versions for a specific product
app.get('/api/mmr/:product_sku/versions', authenticateToken, async (req, res) => {
    try {
        const productSku = req.params.product_sku;
        console.log(`Fetching MMR versions for product: ${productSku}`);
        
        // Get versions for this product
        const result = await pgPool.query(`
            SELECT version, created_at
            FROM MMRs 
            WHERE product_sku = $1 AND is_active = true
            ORDER BY version DESC
        `, [productSku]);
        
        console.log(`Found ${result.rowCount} MMR versions for product ${productSku}`);
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching MMR versions for product:', err);
        res.status(500).json({ error: err.message });
    }
});

// Debug endpoint to get all MMRs for a product (no auth required)
app.get('/api/mmr/:product_sku/versions', authenticateToken, async (req, res) => {
    try {
        const productSku = req.params.product_sku;
        console.log(`Fetching MMR versions for product: ${productSku}`);
        
        // Get versions for this product
        const result = await pgPool.query(`
            SELECT version, created_at
            FROM MMRs 
            WHERE product_sku = $1 AND is_active = true
            ORDER BY version DESC
        `, [productSku]);
        
        console.log(`Found ${result.rowCount} MMR versions for product ${productSku}`);
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching MMR versions for product:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get all steps for a specific production order
app.get('/api/v1/production-orders/:id/steps', authenticateToken, async (req, res) => {
    const orderId = req.params.id;
    
    try {
        console.log(`Fetching steps for production order ID: ${orderId}`);
        
        // Get the production order to verify it exists
        const orderResult = await pgPool.query(
            `SELECT * FROM ProductionOrders WHERE id = $1`,
            [orderId]
        );
        
        if (orderResult.rows.length === 0) {
            return res.status(404).json({ 
                error: 'Production order not found',
                message: `No production order found with ID ${orderId}`
            });
        }
        
        const order = orderResult.rows[0];
        console.log(`Order ${orderId} details:`, {
            product_sku: order.product_sku,
            mmr_product_sku: order.mmr_product_sku,
            mmr_version: order.mmr_version
        });
        
        // Fetch all steps for this production order
        const stepsResult = await pgPool.query(
            `SELECT * FROM ProductionSteps 
             WHERE production_order_id = $1 
             ORDER BY step_number ASC`,
            [orderId]
        );
        
        console.log(`Found ${stepsResult.rows.length} steps for production order ${orderId}`);
        
        // Check if MMR product SKU and version are available
        if (!order.mmr_product_sku || !order.mmr_version) {
            console.log(`Warning: Order ${orderId} has no MMR product SKU or version specified`);
            return res.json(stepsResult.rows);
        }
                
        // Get MMR substeps if available
        console.log(`Fetching substeps for MMR product SKU: ${order.mmr_product_sku}, version: ${order.mmr_version}`);
        
        const subStepsResult = await pgPool.query(
            `SELECT * FROM MMRSubSteps
             WHERE mmr_product_sku = $1 AND mmr_version = $2
             ORDER BY main_step_number, sub_step_number`,
            [order.mmr_product_sku, order.mmr_version]
        );
        
        console.log(`Found ${subStepsResult.rows.length} substeps for MMR product ${order.mmr_product_sku}`);
        
        // Format the response to include substeps within each main step
        const formattedSteps = stepsResult.rows.map(step => {
            // Find all substeps for this main step
            const substeps = subStepsResult.rows.filter(
                substep => Number(substep.main_step_number) === Number(step.step_number)
            );
            
            // Changed console.log to avoid potential issues
            if (substeps.length > 0) {
                console.log(`Matched ${substeps.length} substeps for step ${step.step_number}`);
            }
            
            return {
                ...step,
                // Include both sub_steps (for the updated frontend) and subSteps (for backward compatibility)
                sub_steps: substeps.map(sub => ({
                    sub_step_number: sub.sub_step_number,
                    description: sub.description,
                    step_type: sub.step_type,
                    background_color: sub.background_color
                })),
                subSteps: substeps.map(sub => ({
                    sub_step_number: sub.sub_step_number,
                    description: sub.description,
                    step_type: sub.step_type,
                    background_color: sub.background_color
                }))
            };
        });
        
        res.json(formattedSteps);
        
    } catch (error) {
        console.error(`Error fetching steps for production order ${orderId}:`, error);
        res.status(500).json({ 
            error: 'Failed to fetch production steps',
            details: error.message
        });
    }
});

// Complete a production step
app.patch('/api/v1/production-orders/:orderId/steps/:stepId', authenticateToken, async (req, res) => {
    const { orderId, stepId } = req.params;
    const { completed, completed_by } = req.body;
    
    console.log(`Request to complete step ${stepId} for order ${orderId}`, req.body);
    
    try {
        // Verify the production order and step exist
        const orderCheck = await pgPool.query(
            'SELECT * FROM ProductionOrders WHERE id = $1',
            [orderId]
        );
        
        if (orderCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Production order not found' });
        }
        
        const stepCheck = await pgPool.query(
            'SELECT * FROM ProductionSteps WHERE id = $1 AND production_order_id = $2',
            [stepId, orderId]
        );
        
        if (stepCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Production step not found for this order' });
        }
        
        // Update the step as completed
        const result = await pgPool.query(
            `UPDATE ProductionSteps 
             SET completed = $1, 
                 completed_by = $2, 
                 completed_at = CURRENT_TIMESTAMP
             WHERE id = $3 AND production_order_id = $4
             RETURNING *`,
            [completed === false ? false : true, completed_by, stepId, orderId]
        );
        
        // If all steps are completed, update the order status to "In Progress"
        if (completed !== false) {
            const allStepsResult = await pgPool.query(
                'SELECT COUNT(*) as total, SUM(CASE WHEN completed THEN 1 ELSE 0 END) as completed FROM ProductionSteps WHERE production_order_id = $1',
                [orderId]
            );
            
            const { total, completed: completedSteps } = allStepsResult.rows[0];
            
            if (completedSteps > 0) {
                // Even if just one step is completed, mark as "In Progress"
                await pgPool.query(
                    "UPDATE ProductionOrders SET status = 'In Progress', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'Pending'",
                    [orderId]
                );
            }
        }
        
        res.json({ 
            success: true, 
            message: 'Step updated successfully',
            step: result.rows[0]
        });
        
    } catch (error) {
        console.error(`Error completing step ${stepId} for order ${orderId}:`, error);
        res.status(500).json({ 
            error: 'Failed to complete production step',
            details: error.message
        });
    }
});

// Complete a production order
app.post('/api/v1/production-orders/:id/complete', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const { actual_yield, completed_by } = req.body;
    
    if (!actual_yield || !completed_by) {
        return res.status(400).json({ error: 'Actual yield and completed by are required' });
    }
    
    try {
        // Verify all steps are completed
        const stepsCheck = await pgPool.query(
            'SELECT COUNT(*) as total, SUM(CASE WHEN completed THEN 1 ELSE 0 END) as completed FROM ProductionSteps WHERE production_order_id = $1',
            [id]
        );
        
        const { total, completed } = stepsCheck.rows[0];
        
        if (completed < total) {
            return res.status(400).json({ 
                error: 'Cannot complete order with incomplete steps',
                completed,
                total
            });
        }
        
        // Update the production order as completed
        const result = await pgPool.query(
            `UPDATE ProductionOrders 
             SET status = 'Completed', 
                 actual_yield = $1, 
                 completed_by = $2,
                 completed_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $3
             RETURNING *`,
            [actual_yield, completed_by, id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Production order not found' });
        }
        
        // Add completed product to inventory
        const order = result.rows[0];
        
        // Get product details
        const productResult = await pgPool.query(
            'SELECT * FROM InventoryItems WHERE sku = $1',
            [order.product_sku]
        );
        
        if (productResult.rows.length > 0) {
            const product = productResult.rows[0];
            
            // Update product stock level
            await pgPool.query(
                'UPDATE InventoryItems SET stock_level = stock_level + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                [actual_yield, product.id]
            );
            
            // Create inventory batch
            await pgPool.query(
                `INSERT INTO InventoryBatches (inventory_item_id, batch_number, stock_level, created_at)
                 VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
                [product.id, order.finished_batch_number, actual_yield]
            );
        }
        
        res.json({
            success: true,
            message: 'Production order completed successfully',
            order: result.rows[0]
        });
        
    } catch (error) {
        console.error(`Error completing production order ${id}:`, error);
        res.status(500).json({ 
            error: 'Failed to complete production order',
            details: error.message
        });
    }
});

// Setup upload directory for test reports

// FBA Transfers API Endpoints

// Create the FBATransfers table if it doesn't exist
async function createFBATransfersTable() {
    const client = await pgPool.connect();
    try {
        // Check if table exists
        const checkResult = await client.query(`
            SELECT to_regclass('public.FBATransfers') IS NOT NULL as exists;
        `);
        
        if (!checkResult.rows[0].exists) {
            console.log('Creating FBATransfers table...');
            
            await client.query(`
                CREATE TABLE IF NOT EXISTS FBATransfers (
                    id SERIAL PRIMARY KEY,
                    inventory_item_id INTEGER REFERENCES InventoryItems(id),
                    sku VARCHAR(50) NOT NULL,
                    quantity INTEGER NOT NULL,
                    transfer_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    status VARCHAR(20) NOT NULL DEFAULT 'in_transit',
                    shipment_id VARCHAR(100),
                    amazon_shipment_id VARCHAR(100),
                    tracking_number VARCHAR(100),
                    notes TEXT,
                    created_by INTEGER REFERENCES Users(id),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
                
                CREATE INDEX idx_fba_transfers_sku ON FBATransfers(sku);
                CREATE INDEX idx_fba_transfers_status ON FBATransfers(status);
                CREATE INDEX idx_fba_transfers_date ON FBATransfers(transfer_date);
            `);
            
            console.log('FBATransfers table created successfully');
        } else {
            console.log('FBATransfers table already exists');
        }
    } catch (error) {
        console.error('Error creating FBATransfers table:', error);
    } finally {
        client.release();
    }
}

// Call during app initialization
createFBATransfersTable();

// Get all FBA transfers
app.get('/api/fba/transfers', authenticateToken, async (req, res) => {
    try {
        const { status, sku, page = 1, limit = 50 } = req.query;
        const offset = (page - 1) * limit;
        
        // Build the SQL query with optional filters
        let query = `
            SELECT 
                ft.id, ft.sku, ft.quantity, ft.transfer_date, ft.status,
                ft.shipment_id, ft.amazon_shipment_id, ft.tracking_number, ft.notes,
                ii.name AS product_name, u.username AS created_by
            FROM FBATransfers ft
            LEFT JOIN InventoryItems ii ON ft.sku = ii.sku
            LEFT JOIN Users u ON ft.created_by = u.id
            WHERE 1=1
        `;
        const queryParams = [];
        
        // Add filters if provided
        if (status) {
            queryParams.push(status);
            query += ` AND ft.status = $${queryParams.length}`;
        }
        
        if (sku) {
            queryParams.push(`%${sku}%`);
            query += ` AND ft.sku ILIKE $${queryParams.length}`;
        }
        
        // Add ordering and pagination
        query += ` ORDER BY ft.transfer_date DESC LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`;
        queryParams.push(limit, offset);
        
        // Execute the query
        const result = await pgPool.query(query, queryParams);
        
        // Count total records for pagination
        const countQuery = `
            SELECT COUNT(*) AS total
            FROM FBATransfers ft
            WHERE 1=1
            ${status ? ` AND ft.status = '${status}'` : ''}
            ${sku ? ` AND ft.sku ILIKE '%${sku}%'` : ''}
        `;
        const countResult = await pgPool.query(countQuery);
        const total = parseInt(countResult.rows[0].total);
        
        res.json({
            success: true,
            transfers: result.rows,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Error fetching FBA transfers:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching FBA transfers',
            error: error.message
        });
    }
});

// Get a single FBA transfer by ID
app.get('/api/fba/transfers/:id', authenticateToken, async (req, res) => {
    try {
        const result = await pgPool.query(`
            SELECT 
                ft.*, 
                ii.name AS product_name,
                u.username AS created_by_name
            FROM FBATransfers ft
            LEFT JOIN InventoryItems ii ON ft.sku = ii.sku
            LEFT JOIN Users u ON ft.created_by = u.id
            WHERE ft.id = $1
        `, [req.params.id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Transfer not found'
            });
        }
        
        res.json({
            success: true,
            transfer: result.rows[0]
        });
    } catch (error) {
        console.error('Error fetching FBA transfer:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching FBA transfer',
            error: error.message
        });
    }
});

// Create FBA transfer
app.post('/api/fba/transfers', authenticateToken, async (req, res) => {
    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');
        
        const { sku, quantity, shipment_id, tracking_number, notes, user_id } = req.body;
        
        console.log('FBA Transfer Request:', { 
            sku, 
            quantity, 
            shipment_id, 
            tracking_number, 
            notes, 
            requestUserId: user_id,
            tokenUserId: req.user?.id 
        });
        
        // Get the user ID (either from auth token or from request body)
        const userId = req.user?.id || user_id || null;
        console.log('Creating FBA transfer for user ID:', userId);
        
        // Validate user ID
        if (!userId) {
            return res.status(400).json({
                success: false,
                message: 'User ID is required'
            });
        }
        
        // Validate input
        if (!sku || !quantity) {
            return res.status(400).json({
                success: false,
                message: 'SKU and quantity are required'
            });
        }
        
        // Check if the SKU exists in inventory
        const inventoryResult = await client.query(
            'SELECT id, stock_level, name FROM InventoryItems WHERE sku = $1',
            [sku]
        );
        
        if (inventoryResult.rows.length === 0) {
            console.log(`Product not found in inventory: ${sku}`);
            return res.status(404).json({
                success: false,
                message: 'Product not found in inventory'
            });
        }
        
        const inventoryItem = inventoryResult.rows[0];
        console.log(`Found inventory item:`, inventoryItem);
        
        // Check if there's enough stock
        if (parseFloat(inventoryItem.stock_level) < quantity) {
            console.log(`Insufficient stock for ${sku}: Available ${inventoryItem.stock_level}, Requested: ${quantity}`);
            return res.status(400).json({
                success: false,
                message: `Insufficient stock. Available: ${inventoryItem.stock_level}, Requested: ${quantity}`
            });
        }
        
        // Check if there's an Amazon SKU mapping
        console.log(`Checking Amazon SKU mapping for internal SKU: ${sku}`);
        const mappingQuery = 'SELECT id, platform_sku, internal_sku FROM SkuMapping WHERE LOWER(internal_sku) = LOWER($1) AND platform = $2';
        console.log('Mapping query:', mappingQuery, [sku, 'amazon']);
        
        const mappingResult = await client.query(mappingQuery, [sku, 'amazon']);
        
        console.log(`SKU mapping results for ${sku}:`, mappingResult.rows);
        
        if (mappingResult.rows.length === 0) {
            console.log(`No Amazon SKU mapping found for ${sku}`);
            
            // Debug: Get all sku mappings for this SKU regardless of platform
            const allMappingsResult = await client.query(
                'SELECT platform, platform_sku FROM SkuMapping WHERE LOWER(internal_sku) = LOWER($1)',
                [sku]
            );
            console.log(`All SKU mappings for ${sku}:`, allMappingsResult.rows);
            
            // Get similar SKUs to help diagnose issues
            const similarSkusResult = await client.query(
                "SELECT internal_sku, platform, platform_sku FROM SkuMapping WHERE internal_sku ILIKE $1",
                [`%${sku}%`]
            );
            console.log(`Similar SKUs for ${sku}:`, similarSkusResult.rows);
            
            return res.status(400).json({
                success: false,
                message: `No Amazon SKU mapping found for this product (SKU: ${sku})`,
                debug: {
                    other_mappings: allMappingsResult.rows,
                    similar_skus: similarSkusResult.rows
                }
            });
        }
        
        const amazonMapping = mappingResult.rows[0];
        
        // Create the transfer record
        const transferResult = await client.query(
            `INSERT INTO FBATransfers 
            (inventory_item_id, sku, quantity, shipment_id, tracking_number, notes, created_by, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id`,
            [
                inventoryItem.id,
                inventoryItem.sku, // Use the exact case from the inventory item
                quantity,
                shipment_id || null,
                tracking_number || null,
                notes || null,
                userId,
                'in_transit'
            ]
        );
        
        const transferId = transferResult.rows[0].id;
        
        // Decrease warehouse inventory
        await client.query(
            'UPDATE InventoryItems SET stock_level = stock_level - $1 WHERE id = $2',
            [quantity, inventoryItem.id]
        );
        
        // Don't update FBA inventory here - it will be updated when the transfer is confirmed
        // or through the regular Amazon API sync
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            message: 'FBA transfer created successfully',
            transfer_id: transferId,
            inventory_sku: inventoryItem.sku,
            amazon_sku: amazonMapping.platform_sku
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating FBA transfer:', error);
        res.status(500).json({
            success: false,
            message: 'Error creating FBA transfer',
            error: error.message,
            details: error.stack
        });
    } finally {
        client.release();
    }
});

// Confirm FBA transfer
app.put('/api/fba/transfers/:id/confirm', authenticateToken, async (req, res) => {
    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');
        
        const transferId = req.params.id;
        
        // Find the transfer
        const transferResult = await client.query(
            'SELECT * FROM FBATransfers WHERE id = $1',
            [transferId]
        );
        
        if (transferResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Transfer not found'
            });
        }
        
        const transfer = transferResult.rows[0];
        
        // Check if the transfer is already confirmed
        if (transfer.status !== 'in_transit') {
            return res.status(400).json({
                success: false,
                message: `Transfer cannot be confirmed because it is already ${transfer.status}`
            });
        }
        
        // Update the transfer status
        await client.query(
            'UPDATE FBATransfers SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            ['confirmed', transferId]
        );
        
        // Do NOT update FBA inventory here - we'll rely on the Amazon API sync
        // for actual FBA inventory levels
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            message: 'Transfer confirmed successfully'
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error confirming FBA transfer:', error);
        res.status(500).json({
            success: false,
            message: 'Error confirming FBA transfer',
            error: error.message
        });
    } finally {
        client.release();
    }
});

// Enhance existing inventory endpoint to allow filtering for Amazon mappings
// This assumes you have an existing /api/inventory endpoint
// Modify the WHERE clause in that endpoint to include this filter when the query param is present
// if (req.query.hasAmazonMapping === 'true') {
//     whereConditions.push(`EXISTS (
//         SELECT 1 FROM SkuMapping 
//         WHERE SkuMapping.internal_sku = ii.sku 
//         AND SkuMapping.platform = 'amazon'
//     )`);
// }

// ... existing code continues ...

// Debug route for checking SKU mappings
app.get('/api/debug/sku-mapping/:sku', authenticateToken, async (req, res) => {
    try {
        const sku = req.params.sku;
        console.log(`Debug SKU mapping request for: ${sku}`);
        
        // Check SKU mappings (case sensitive)
        const exactResult = await pgPool.query(
            'SELECT * FROM SkuMapping WHERE internal_sku = $1',
            [sku]
        );
        
        // Check SKU mappings (case insensitive)
        const caseInsensitiveResult = await pgPool.query(
            'SELECT * FROM SkuMapping WHERE LOWER(internal_sku) = LOWER($1)',
            [sku]
        );
        
        // Check if SKU exists in inventory
        const inventoryResult = await pgPool.query(
            'SELECT id, sku, name, type FROM InventoryItems WHERE sku = $1',
            [sku]
        );
        
        // Check possible Amazon mappings specifically
        const amazonMappingResult = await pgPool.query(
            'SELECT * FROM SkuMapping WHERE LOWER(internal_sku) = LOWER($1) AND platform = $2',
            [sku, 'amazon']
        );
        
        // Check if there are any mappings for this SKU with different casing
        const similarSkuResult = await pgPool.query(
            'SELECT * FROM SkuMapping WHERE LOWER(internal_sku) LIKE LOWER($1) OR internal_sku LIKE $1',
            [`%${sku}%`]
        );
        
        // Get the column names from SkuMapping table to understand its structure
        const tableStructureResult = await pgPool.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'skumapping'
        `);
        
        res.json({
            success: true,
            debug_info: {
                requested_sku: sku,
                exact_matches: exactResult.rows,
                case_insensitive_matches: caseInsensitiveResult.rows,
                inventory_item: inventoryResult.rows,
                amazon_mappings: amazonMappingResult.rows,
                similar_skus: similarSkuResult.rows,
                table_structure: tableStructureResult.rows
            }
        });
    } catch (error) {
        console.error('Error in debug SKU mapping endpoint:', error);
        res.status(500).json({
            success: false,
            message: 'Error checking SKU mapping',
            error: error.message
        });
    }
});

// Debug route to list all SKU mappings
app.get('/api/debug/all-sku-mappings', authenticateToken, async (req, res) => {
    try {
        // Get all SKU mappings from the database
        const result = await pgPool.query(`
            SELECT 
                id, internal_sku, platform, platform_sku,
                created_at, updated_at
            FROM SkuMapping
            ORDER BY internal_sku, platform
        `);
        
        // Get the platform counts
        const platformCountsResult = await pgPool.query(`
            SELECT platform, COUNT(*) as count
            FROM SkuMapping
            GROUP BY platform
            ORDER BY count DESC
        `);
        
        // Count SKUs without mappings
        const unmappedSkusResult = await pgPool.query(`
            SELECT COUNT(*) as count
            FROM InventoryItems ii
            WHERE ii.type = 'finished good' 
            AND NOT EXISTS (
                SELECT 1 FROM SkuMapping sm 
                WHERE LOWER(sm.internal_sku) = LOWER(ii.sku)
                AND sm.platform = 'amazon'
            )
        `);
        
        // Count SKUs with amazon mappings
        const mappedSkusResult = await pgPool.query(`
            SELECT COUNT(*) as count
            FROM InventoryItems ii
            WHERE ii.type = 'finished good' 
            AND EXISTS (
                SELECT 1 FROM SkuMapping sm 
                WHERE LOWER(sm.internal_sku) = LOWER(ii.sku)
                AND sm.platform = 'amazon'
            )
        `);
        
        res.json({
            success: true,
            total_mappings: result.rows.length,
            platform_counts: platformCountsResult.rows,
            unmapped_finished_goods: unmappedSkusResult.rows[0].count,
            mapped_finished_goods: mappedSkusResult.rows[0].count,
            mappings: result.rows
        });
    } catch (error) {
        console.error('Error in debug all SKU mappings endpoint:', error);
        res.status(500).json({
            success: false,
            message: 'Error retrieving SKU mappings',
            error: error.message
        });
    }
});

// Debug route to fix SKU mapping issues
app.get('/api/debug/fix-sku-mapping/:sku', async (req, res) => {
    try {
        const sku = req.params.sku;
        console.log(`Attempting to fix SKU mapping for: ${sku}`);
        
        // 1. First check if an exact mapping exists
        const exactResult = await pgPool.query(
            'SELECT * FROM SkuMapping WHERE internal_sku = $1 AND platform = $2',
            [sku, 'amazon']
        );
        
        if (exactResult.rows.length > 0) {
            console.log(`Exact match already exists for ${sku}`);
            return res.json({
                success: true,
                message: 'Mapping already exists',
                mapping: exactResult.rows[0]
            });
        }
        
        // 2. Check for a case-insensitive match
        const caseInsensitiveResult = await pgPool.query(
            'SELECT * FROM SkuMapping WHERE LOWER(internal_sku) = LOWER($1) AND platform = $2',
            [sku, 'amazon']
        );
        
        if (caseInsensitiveResult.rows.length > 0) {
            const existingMapping = caseInsensitiveResult.rows[0];
            console.log(`Found case-insensitive match: ${existingMapping.internal_sku}`);
            
            // 3. Update the mapping to use the exact requested SKU case
            await pgPool.query(
                'UPDATE SkuMapping SET internal_sku = $1 WHERE id = $2',
                [sku, existingMapping.id]
            );
            
            console.log(`Updated mapping case for ${sku}`);
            return res.json({
                success: true,
                message: 'Fixed case sensitivity in mapping',
                original: existingMapping,
                updated_sku: sku
            });
        }
        
        // 4. Create a temporary mapping for testing if inventory item exists
        const inventoryResult = await pgPool.query(
            'SELECT * FROM InventoryItems WHERE LOWER(sku) = LOWER($1)',
            [sku]
        );
        
        if (inventoryResult.rows.length > 0) {
            const inventoryItem = inventoryResult.rows[0];
            console.log(`Creating temporary Amazon mapping for ${sku}`);
            
            const tempPlatformSku = `AMZN-${sku}`;
            await pgPool.query(
                'INSERT INTO skumapping (platform_sku, internal_sku, platform, product_name) VALUES ($1, $2, $3, $4)',
                [tempPlatformSku, sku, 'amazon', inventoryItem.name]
            );
            
            return res.json({
                success: true,
                message: 'Created temporary mapping',
                mapping: {
                    platform: 'amazon',
                    internal_sku: sku,
                    platform_sku: tempPlatformSku,
                    product_name: inventoryItem.name
                }
            });
        }
        
        return res.status(404).json({
            success: false,
            message: 'No inventory item found with this SKU'
        });
    } catch (error) {
        console.error('Error fixing SKU mapping:', error);
        res.status(500).json({
            success: false,
            message: 'Error fixing SKU mapping',
            error: error.message
        });
    }
});