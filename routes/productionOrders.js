const express = require('express');
const router = express.Router();
const { convert, areUnitsCompatible } = require('../utils/unitConversion');
const { authenticateToken, checkPermission } = require('../middleware/auth');

// Add a debug route at the top
router.post('/debug', async (req, res) => {
    try {
        console.log('Debug route called');
        console.log('Request body:', req.body);
        res.json({
            success: true,
            receivedData: req.body
        });
    } catch (error) {
        console.error('Error in debug route:', error);
        res.status(500).json({ error: error.message });
    }
});

// Helper function to format inventory error messages
function formatInventoryError(component, requiredQty, availableQty, unit) {
    return {
        code: 'INSUFFICIENT_INVENTORY',
        message: `Insufficient stock for ${component.name} (${component.sku}): ` +
                `need ${requiredQty} ${unit}, have ${availableQty} ${unit}`,
        details: {
            sku: component.sku,
            name: component.name,
            required: requiredQty,
            available: availableQty,
            unit: unit,
            shortage: requiredQty - availableQty
        }
    };
}

// Helper function to check inventory levels
async function checkInventoryLevels(client, mmr_product_sku, mmr_version, quantity) {
    // Get MMR details
    const mmrResult = await client.query(
        'SELECT * FROM MMRs WHERE product_sku = $1 AND version = $2',
        [mmr_product_sku, mmr_version]
    );

    if (mmrResult.rows.length === 0) {
        throw new Error(`MMR not found for ${mmr_product_sku} v${mmr_version}`);
    }

    const mmr = mmrResult.rows[0];
    const scalingFactor = quantity / mmr.base_quantity;

    // Get all components (ingredients, packaging, labels)
    const componentsResult = await client.query(`
        SELECT 
            'ingredient' as component_type,
            mi.ingredient_sku as sku,
            ii.name,
            mi.quantity,
            mi.unit_type as mmr_unit,
            ii.unit_type as inventory_unit,
            ii.stock_level
        FROM MMRIngredients mi
        JOIN InventoryItems ii ON mi.ingredient_sku = ii.sku
        WHERE mi.mmr_product_sku = $1 AND mi.mmr_version = $2
        UNION ALL
        SELECT 
            'packaging' as component_type,
            mp.packaging_sku as sku,
            ii.name,
            mp.quantity,
            mp.unit_type as mmr_unit,
            ii.unit_type as inventory_unit,
            ii.stock_level
        FROM MMRPackaging mp
        JOIN InventoryItems ii ON mp.packaging_sku = ii.sku
        WHERE mp.mmr_product_sku = $1 AND mp.mmr_version = $2
        UNION ALL
        SELECT 
            'label' as component_type,
            ml.label_sku as sku,
            ii.name,
            ml.quantity,
            ml.unit_type as mmr_unit,
            ii.unit_type as inventory_unit,
            ii.stock_level
        FROM MMRLabels ml
        JOIN InventoryItems ii ON ml.label_sku = ii.sku
        WHERE ml.mmr_product_sku = $1 AND ml.mmr_version = $2`,
        [mmr_product_sku, mmr_version]
    );

    const inventoryWarnings = [];
    const inventoryErrors = [];

    // Check each component
    for (const component of componentsResult.rows) {
        const requiredQuantity = component.quantity * scalingFactor;
        
        // Validate unit compatibility
        if (!areUnitsCompatible(component.mmr_unit, component.inventory_unit)) {
            inventoryErrors.push({
                sku: component.sku,
                name: component.name,
                type: component.component_type,
                error: `Incompatible units: MMR uses ${component.mmr_unit} but inventory uses ${component.inventory_unit}`
            });
            continue;
        }

        // Convert to inventory units
        let requiredQuantityInInventoryUnits;
        try {
            requiredQuantityInInventoryUnits = convert(
                requiredQuantity,
                component.mmr_unit,
                component.inventory_unit
            );
        } catch (error) {
            inventoryErrors.push({
                sku: component.sku,
                name: component.name,
                type: component.component_type,
                error: `Unit conversion failed: ${error.message}`
            });
            continue;
        }

        // Check stock level
        if (requiredQuantityInInventoryUnits > component.stock_level) {
            inventoryWarnings.push({
                sku: component.sku,
                name: component.name,
                type: component.component_type,
                required: requiredQuantityInInventoryUnits,
                available: component.stock_level,
                unit: component.inventory_unit,
                shortage: requiredQuantityInInventoryUnits - component.stock_level
            });
        }
    }

    return {
        mmr,
        base_quantity: mmr.base_quantity,
        scaling_factor: scalingFactor,
        has_warnings: inventoryWarnings.length > 0,
        has_errors: inventoryErrors.length > 0,
        warnings: inventoryWarnings,
        errors: inventoryErrors,
        components: componentsResult.rows
    };
}

// Check inventory levels for a production order
router.post('/check-inventory', authenticateToken, async (req, res) => {
    let client;
    try {
        client = await req.app.locals.pgPool.connect();
        const { mmr_product_sku, mmr_version, quantity } = req.body;

        if (!mmr_product_sku || !mmr_version || !quantity) {
            return res.status(400).json({
                code: 'MISSING_FIELDS',
                message: 'Missing required fields',
                details: {
                    required: ['mmr_product_sku', 'mmr_version', 'quantity'],
                    provided: { mmr_product_sku, mmr_version, quantity }
                }
            });
        }

        const result = await checkInventoryLevels(client, mmr_product_sku, mmr_version, quantity);
        
        res.json({
            mmr_product_sku,
            mmr_version,
            quantity,
            ...result
        });

    } catch (error) {
        console.error('Error checking inventory levels:', error);
        res.status(500).json({
            code: 'INVENTORY_CHECK_ERROR',
            message: error.message,
            details: error.details || null
        });
    } finally {
        if (client) {
            client.release();
        }
    }
});

// Create a new production order
router.post('/', authenticateToken, checkPermission('create_production_order'), async (req, res) => {
    let client;
    try {
        client = await req.app.locals.pgPool.connect();
        const { mmr_product_sku, mmr_version, quantity, force = false } = req.body;

        if (!mmr_product_sku || !mmr_version || !quantity) {
            return res.status(400).json({
                code: 'MISSING_FIELDS',
                message: 'Missing required fields',
                details: {
                    required: ['mmr_product_sku', 'mmr_version', 'quantity'],
                    provided: { mmr_product_sku, mmr_version, quantity }
                }
            });
        }

        // Check inventory levels
        const inventoryCheck = await checkInventoryLevels(client, mmr_product_sku, mmr_version, quantity);

        // If there are errors, we cannot proceed
        if (inventoryCheck.has_errors) {
            return res.status(400).json({
                code: 'UNIT_COMPATIBILITY_ERROR',
                message: 'Cannot create production order due to unit compatibility issues',
                details: inventoryCheck.errors
            });
        }

        // If there are warnings and force is not true, return the warnings
        if (inventoryCheck.has_warnings && !force) {
            return res.status(409).json({
                code: 'INSUFFICIENT_INVENTORY',
                message: 'Insufficient inventory levels detected',
                details: {
                    warnings: inventoryCheck.warnings,
                    canForce: true,
                    forceMessage: 'Set force=true in the request body to create the production order anyway'
                }
            });
        }

        // If we get here, either there are no warnings or force=true
        // Proceed with creating the production order...
        await client.query('BEGIN');

        // Get MMR details
        const mmrResult = await client.query(
            'SELECT * FROM MMRs WHERE product_sku = $1 AND version = $2',
            [mmr_product_sku, mmr_version]
        );

        if (mmrResult.rows.length === 0) {
            throw {
                code: 'MMR_NOT_FOUND',
                message: `MMR not found for ${mmr_product_sku} v${mmr_version}`,
                details: { mmr_product_sku, mmr_version }
            };
        }

        const mmr = mmrResult.rows[0];
        const scalingFactor = quantity / mmr.base_quantity;

        // Create production order
        const orderResult = await client.query(
            `INSERT INTO ProductionOrders 
            (product_sku, quantity, mmr_product_sku, mmr_version, status) 
            VALUES ($1, $2, $3, $4, 'Pending') 
            RETURNING id`,
            [mmr_product_sku, quantity, mmr_product_sku, mmr_version]
        );

        const orderId = orderResult.rows[0].id;

        // Get ingredients with their inventory units
        const ingredientsResult = await client.query(`
            SELECT 
                mi.*,
                ii.id as item_id,
                ii.name,
                ii.stock_level,
                ii.unit_type as inventory_unit_type
            FROM MMRIngredients mi
            JOIN InventoryItems ii ON mi.ingredient_sku = ii.sku
            WHERE mi.mmr_product_sku = $1 AND mi.mmr_version = $2`,
            [mmr_product_sku, mmr_version]
        );

        // Process ingredients
        const ingredientList = [];
        for (const ingredient of ingredientsResult.rows) {
            const requiredQuantity = ingredient.quantity * scalingFactor;

            // Validate unit compatibility
            if (!areUnitsCompatible(ingredient.unit_type, ingredient.inventory_unit_type)) {
                throw {
                    code: 'UNIT_COMPATIBILITY_ERROR',
                    message: `Incompatible units for ${ingredient.ingredient_sku}: MMR uses ${ingredient.unit_type} but inventory uses ${ingredient.inventory_unit_type}`,
                    details: {
                        sku: ingredient.ingredient_sku,
                        name: ingredient.name,
                        mmr_unit: ingredient.unit_type,
                        inventory_unit: ingredient.inventory_unit_type
                    }
                };
            }

            // Convert to inventory units
            let requiredQuantityInInventoryUnits;
            try {
                requiredQuantityInInventoryUnits = convert(
                    requiredQuantity,
                    ingredient.unit_type,
                    ingredient.inventory_unit_type
                );
            } catch (error) {
                throw {
                    code: 'UNIT_CONVERSION_ERROR',
                    message: `Unit conversion failed for ${ingredient.ingredient_sku}: ${error.message}`,
                    details: {
                        sku: ingredient.ingredient_sku,
                        name: ingredient.name,
                        quantity: requiredQuantity,
                        from_unit: ingredient.unit_type,
                        to_unit: ingredient.inventory_unit_type,
                        error: error.message
                    }
                };
            }

            // Check stock level
            if (requiredQuantityInInventoryUnits > ingredient.stock_level) {
                throw formatInventoryError(
                    ingredient,
                    requiredQuantityInInventoryUnits,
                    ingredient.stock_level,
                    ingredient.inventory_unit_type
                );
            }

            // Record ingredient usage
            await client.query(
                `INSERT INTO ProductionBatches 
                (production_order_id, item_id, quantity_used, item_type, 
                 original_unit, inventory_unit, conversion_factor) 
                VALUES ($1, $2, $3, 'raw_ingredient', $4, $5, $6)`,
                [
                    orderId,
                    ingredient.item_id,
                    requiredQuantityInInventoryUnits,
                    ingredient.unit_type,
                    ingredient.inventory_unit_type,
                    requiredQuantityInInventoryUnits / requiredQuantity
                ]
            );

            // Update inventory
            await client.query(
                `UPDATE InventoryItems 
                 SET stock_level = stock_level - $1 
                 WHERE id = $2`,
                [requiredQuantityInInventoryUnits, ingredient.item_id]
            );

            ingredientList.push(
                `${ingredient.name} (${ingredient.ingredient_sku}): ` +
                `${requiredQuantity.toFixed(2)} ${ingredient.unit_type}`
            );
        }

        // Create steps
        let stepNumber = 1;

        // Ingredients step
        await client.query(
            `INSERT INTO ProductionSteps 
            (production_order_id, step_number, description, quality_checks) 
            VALUES ($1, $2, $3, '[]')`,
            [orderId, stepNumber++, `Gather all required ingredients: ${ingredientList.join(', ')}`]
        );

        // Equipment step
        const equipmentResult = await client.query(
            `SELECT equipment_name 
             FROM MMREquipment 
             WHERE mmr_product_sku = $1 AND mmr_version = $2`,
            [mmr_product_sku, mmr_version]
        );

        const equipmentList = equipmentResult.rows.map(eq => eq.equipment_name);
        await client.query(
            `INSERT INTO ProductionSteps 
            (production_order_id, step_number, description, quality_checks) 
            VALUES ($1, $2, $3, '[]')`,
            [
                orderId,
                stepNumber++,
                equipmentList.length > 0
                    ? `Prepare all required equipment: ${equipmentList.join(', ')}`
                    : 'Prepare all required equipment'
            ]
        );

        // Manufacturing steps
        const stepsResult = await client.query(
            'SELECT * FROM MMRSteps WHERE mmr_product_sku = $1 AND mmr_version = $2 ORDER BY step_number',
            [mmr_product_sku, mmr_version]
        );

        for (const step of stepsResult.rows) {
            await client.query(
                `INSERT INTO ProductionSteps 
                (production_order_id, step_number, description, quality_checks) 
                VALUES ($1, $2, $3, $4)`,
                [orderId, stepNumber++, step.description, step.quality_checks || '[]']
            );
        }

        // Process packaging materials
        const packagingResult = await client.query(`
            SELECT 
                mp.*,
                ii.id as item_id,
                ii.name as packaging_name,
                ii.unit_type as inventory_unit_type
            FROM MMRPackaging mp
            JOIN InventoryItems ii ON mp.packaging_sku = ii.sku
            WHERE mp.mmr_product_sku = $1 AND mp.mmr_version = $2`,
            [mmr_product_sku, mmr_version]
        );

        const packagingList = [];
        for (const pkg of packagingResult.rows) {
            const requiredQuantity = pkg.quantity * scalingFactor;

            // Validate unit compatibility
            if (!areUnitsCompatible(pkg.unit_type, pkg.inventory_unit_type)) {
                throw new Error(
                    `Incompatible units for packaging ${pkg.packaging_sku}: ` +
                    `MMR uses ${pkg.unit_type} but inventory uses ${pkg.inventory_unit_type}`
                );
            }

            // Convert to inventory units
            let requiredQuantityInInventoryUnits;
            try {
                requiredQuantityInInventoryUnits = convert(
                    requiredQuantity,
                    pkg.unit_type,
                    pkg.inventory_unit_type
                );
            } catch (error) {
                throw new Error(
                    `Unit conversion failed for packaging ${pkg.packaging_sku}: ${error.message}`
                );
            }

            // Record packaging usage
            await client.query(
                `INSERT INTO ProductionBatches 
                (production_order_id, item_id, quantity_used, item_type,
                 original_unit, inventory_unit, conversion_factor) 
                VALUES ($1, $2, $3, 'packaging', $4, $5, $6)`,
                [
                    orderId,
                    pkg.item_id,
                    requiredQuantityInInventoryUnits,
                    pkg.unit_type,
                    pkg.inventory_unit_type,
                    requiredQuantityInInventoryUnits / requiredQuantity
                ]
            );

            packagingList.push(
                `${pkg.packaging_name} (${pkg.packaging_sku}): ` +
                `${requiredQuantity.toFixed(2)} ${pkg.unit_type}`
            );
        }

        // Packaging step
        await client.query(
            `INSERT INTO ProductionSteps 
            (production_order_id, step_number, description, quality_checks) 
            VALUES ($1, $2, $3, '[]')`,
            [
                orderId,
                stepNumber++,
                packagingList.length > 0
                    ? `Package the finished product: ${packagingList.join(', ')}`
                    : 'Package the finished product'
            ]
        );

        // Process labels
        const labelsResult = await client.query(`
            SELECT 
                ml.*,
                ii.id as item_id,
                ii.name as label_name,
                ii.unit_type as inventory_unit_type
            FROM MMRLabels ml
            JOIN InventoryItems ii ON ml.label_sku = ii.sku
            WHERE ml.mmr_product_sku = $1 AND ml.mmr_version = $2`,
            [mmr_product_sku, mmr_version]
        );

        const labelList = [];
        for (const label of labelsResult.rows) {
            const requiredQuantity = label.quantity * scalingFactor;

            // Validate unit compatibility
            if (!areUnitsCompatible(label.unit_type, label.inventory_unit_type)) {
                throw new Error(
                    `Incompatible units for label ${label.label_sku}: ` +
                    `MMR uses ${label.unit_type} but inventory uses ${label.inventory_unit_type}`
                );
            }

            // Convert to inventory units
            let requiredQuantityInInventoryUnits;
            try {
                requiredQuantityInInventoryUnits = convert(
                    requiredQuantity,
                    label.unit_type,
                    label.inventory_unit_type
                );
            } catch (error) {
                throw new Error(
                    `Unit conversion failed for label ${label.label_sku}: ${error.message}`
                );
            }

            // Record label usage
            await client.query(
                `INSERT INTO ProductionBatches 
                (production_order_id, item_id, quantity_used, item_type,
                 original_unit, inventory_unit, conversion_factor) 
                VALUES ($1, $2, $3, 'label', $4, $5, $6)`,
                [
                    orderId,
                    label.item_id,
                    requiredQuantityInInventoryUnits,
                    label.unit_type,
                    label.inventory_unit_type,
                    requiredQuantityInInventoryUnits / requiredQuantity
                ]
            );

            labelList.push(
                `${label.label_name} (${label.label_sku}): ` +
                `${requiredQuantity.toFixed(2)} ${label.unit_type}`
            );
        }

        // Labeling step
        await client.query(
            `INSERT INTO ProductionSteps 
            (production_order_id, step_number, description, quality_checks) 
            VALUES ($1, $2, $3, '[]')`,
            [
                orderId,
                stepNumber,
                labelList.length > 0
                    ? `Apply labels to packaged product: ${labelList.join(', ')}`
                    : 'Apply labels to packaged product'
            ]
        );

        await client.query('COMMIT');

        res.status(201).json({
            code: 'SUCCESS',
            message: 'Production order created successfully',
            details: {
                id: orderId,
                product_sku: mmr_product_sku,
                quantity: quantity
            }
        });
    } catch (error) {
        if (client) {
            await client.query('ROLLBACK');
        }
        console.error('Error creating production order:', error);
        
        // Format the error response
        const errorResponse = {
            code: error.code || 'PRODUCTION_ORDER_ERROR',
            message: error.message || 'An error occurred while creating the production order',
            details: error.details || null
        };

        // Determine appropriate status code
        let statusCode = 500;
        switch (error.code) {
            case 'MISSING_FIELDS':
                statusCode = 400;
                break;
            case 'MMR_NOT_FOUND':
                statusCode = 404;
                break;
            case 'INSUFFICIENT_INVENTORY':
            case 'UNIT_COMPATIBILITY_ERROR':
            case 'UNIT_CONVERSION_ERROR':
                statusCode = 409;
                break;
        }

        res.status(statusCode).json(errorResponse);
    } finally {
        if (client) {
            client.release();
        }
    }
});

module.exports = router; 