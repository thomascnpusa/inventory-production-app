const { Pool } = require('pg');
const inventoryService = require('./inventoryService');
const procurementService = require('./procurementService');
require('dotenv').config();

class AlertService {
    constructor() {
        this.pgPool = new Pool({
            user: process.env.PG_USER,
            host: process.env.PG_HOST,
            database: process.env.PG_DATABASE,
            password: process.env.PG_PASSWORD,
            port: process.env.PG_PORT
        });
    }

    async checkLowStock() {
        try {
            const query = `
                SELECT 
                    ii.*,
                    s.name as supplier_name,
                    s.email as supplier_email,
                    s.phone as supplier_phone
                FROM inventoryitems ii
                LEFT JOIN suppliers s ON ii.supplier_id = s.id
                WHERE ii.stock_level <= ii.min_level
                AND ii.type = 'raw material'
                ORDER BY (ii.stock_level::float / ii.min_level::float) ASC
            `;
            
            const result = await this.pgPool.query(query);
            return result.rows;
        } catch (error) {
            console.error('Error checking low stock:', error);
            throw error;
        }
    }

    async checkExpiringItems(daysThreshold = 30) {
        try {
            const query = `
                SELECT 
                    ii.*,
                    s.name as supplier_name,
                    s.email as supplier_email,
                    s.phone as supplier_phone
                FROM inventoryitems ii
                LEFT JOIN suppliers s ON ii.supplier_id = s.id
                WHERE ii.expiration_date IS NOT NULL
                AND ii.expiration_date <= CURRENT_DATE + INTERVAL '$1 days'
                AND ii.stock_level > 0
                ORDER BY ii.expiration_date ASC
            `;
            
            const result = await this.pgPool.query(query, [daysThreshold]);
            return result.rows;
        } catch (error) {
            console.error('Error checking expiring items:', error);
            throw error;
        }
    }

    async createLowStockAlert(item) {
        try {
            const query = `
                INSERT INTO inventory_alerts 
                (inventory_item_id, alert_type, message, status)
                VALUES ($1, 'low_stock', $2, 'active')
                ON CONFLICT (inventory_item_id, alert_type) 
                DO UPDATE SET 
                    message = EXCLUDED.message,
                    status = 'active',
                    updated_at = CURRENT_TIMESTAMP
                RETURNING *
            `;
            
            const message = `Low stock alert for ${item.name} (${item.sku}). Current stock: ${item.stock_level} ${item.unit_type}, Minimum required: ${item.min_level} ${item.unit_type}`;
            
            const result = await this.pgPool.query(query, [item.id, message]);
            return result.rows[0];
        } catch (error) {
            console.error('Error creating low stock alert:', error);
            throw error;
        }
    }

    async createExpirationAlert(item) {
        try {
            const query = `
                INSERT INTO inventory_alerts 
                (inventory_item_id, alert_type, message, status)
                VALUES ($1, 'expiration', $2, 'active')
                ON CONFLICT (inventory_item_id, alert_type) 
                DO UPDATE SET 
                    message = EXCLUDED.message,
                    status = 'active',
                    updated_at = CURRENT_TIMESTAMP
                RETURNING *
            `;
            
            const daysUntilExpiration = Math.ceil((new Date(item.expiration_date) - new Date()) / (1000 * 60 * 60 * 24));
            const message = `Expiration alert for ${item.name} (${item.sku}). Expires in ${daysUntilExpiration} days on ${item.expiration_date}. Current stock: ${item.stock_level} ${item.unit_type}`;
            
            const result = await this.pgPool.query(query, [item.id, message]);
            return result.rows[0];
        } catch (error) {
            console.error('Error creating expiration alert:', error);
            throw error;
        }
    }

    async getActiveAlerts() {
        try {
            const query = `
                SELECT 
                    a.*,
                    ii.name as item_name,
                    ii.sku as item_sku,
                    ii.stock_level,
                    ii.unit_type
                FROM inventory_alerts a
                JOIN inventoryitems ii ON a.inventory_item_id = ii.id
                WHERE a.status = 'active'
                ORDER BY a.created_at DESC
            `;
            
            const result = await this.pgPool.query(query);
            return result.rows;
        } catch (error) {
            console.error('Error getting active alerts:', error);
            throw error;
        }
    }

    async resolveAlert(alertId) {
        try {
            const query = `
                UPDATE inventory_alerts 
                SET status = 'resolved', 
                    resolved_at = CURRENT_TIMESTAMP
                WHERE id = $1
                RETURNING *
            `;
            
            const result = await this.pgPool.query(query, [alertId]);
            return result.rows[0];
        } catch (error) {
            console.error('Error resolving alert:', error);
            throw error;
        }
    }

    async checkAndCreateAlerts() {
        try {
            // Check for low stock items
            const lowStockItems = await this.checkLowStock();
            for (const item of lowStockItems) {
                await this.createLowStockAlert(item);
            }

            // Check for expiring items
            const expiringItems = await this.checkExpiringItems();
            for (const item of expiringItems) {
                await this.createExpirationAlert(item);
            }

            return {
                lowStockAlerts: lowStockItems.length,
                expirationAlerts: expiringItems.length
            };
        } catch (error) {
            console.error('Error checking and creating alerts:', error);
            throw error;
        }
    }

    async automateProcurement() {
        try {
            const lowStockItems = await this.checkLowStock();
            if (lowStockItems.length === 0) return { ordersCreated: 0 };

            // Group items by supplier
            const itemsBySupplier = lowStockItems.reduce((acc, item) => {
                if (!item.supplier_id) return acc;
                if (!acc[item.supplier_id]) {
                    acc[item.supplier_id] = [];
                }
                acc[item.supplier_id].push(item);
                return acc;
            }, {});

            // Create procurement orders for each supplier
            const ordersCreated = [];
            for (const [supplierId, items] of Object.entries(itemsBySupplier)) {
                const orderItems = items.map(item => ({
                    inventory_item_id: item.id,
                    quantity: Math.ceil(item.min_level * 1.5), // Order 50% more than minimum
                    unit_price: item.unit_price || 0 // You might want to store this in the inventory items table
                }));

                const order = await procurementService.createProcurementOrder({
                    supplier_id: supplierId,
                    status: 'pending',
                    notes: 'Automatically generated order for low stock items',
                    items: orderItems
                });

                ordersCreated.push(order);
            }

            return { ordersCreated: ordersCreated.length };
        } catch (error) {
            console.error('Error automating procurement:', error);
            throw error;
        }
    }
}

module.exports = new AlertService(); 