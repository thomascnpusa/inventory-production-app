const { Pool } = require('pg');
require('dotenv').config();

class SupplierService {
    constructor() {
        this.pgPool = new Pool({
            user: process.env.PG_USER,
            host: process.env.PG_HOST,
            database: process.env.PG_DATABASE,
            password: process.env.PG_PASSWORD,
            port: process.env.PG_PORT
        });
    }

    async createSupplier(supplierData) {
        try {
            const query = `
                INSERT INTO suppliers 
                (name, contact_info, email, phone, address)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING *
            `;
            
            const result = await this.pgPool.query(query, [
                supplierData.name,
                supplierData.contact_info,
                supplierData.email,
                supplierData.phone,
                supplierData.address
            ]);
            
            return result.rows[0];
        } catch (error) {
            console.error('Error creating supplier:', error);
            throw error;
        }
    }

    async updateSupplier(id, updates) {
        try {
            const allowedFields = ['name', 'contact_info', 'email', 'phone', 'address'];
            const setClause = Object.keys(updates)
                .filter(key => allowedFields.includes(key))
                .map((key, index) => `${key} = $${index + 2}`)
                .join(', ');

            if (!setClause) {
                throw new Error('No valid fields to update');
            }

            const query = `
                UPDATE suppliers 
                SET ${setClause}
                WHERE id = $1
                RETURNING *
            `;

            const values = [id, ...Object.values(updates).filter((_, index) => 
                allowedFields.includes(Object.keys(updates)[index]))];

            const result = await this.pgPool.query(query, values);
            return result.rows[0];
        } catch (error) {
            console.error('Error updating supplier:', error);
            throw error;
        }
    }

    async getSupplier(id) {
        try {
            const query = `
                SELECT s.*, 
                    COUNT(ii.id) as total_items,
                    COUNT(CASE WHEN ii.stock_level <= ii.min_level THEN 1 END) as low_stock_items
                FROM suppliers s
                LEFT JOIN inventoryitems ii ON s.id = ii.supplier_id
                WHERE s.id = $1
                GROUP BY s.id
            `;
            
            const result = await this.pgPool.query(query, [id]);
            return result.rows[0];
        } catch (error) {
            console.error('Error getting supplier:', error);
            throw error;
        }
    }

    async getAllSuppliers() {
        try {
            const query = `
                SELECT s.*, 
                    COUNT(ii.id) as total_items,
                    COUNT(CASE WHEN ii.stock_level <= ii.min_level THEN 1 END) as low_stock_items
                FROM suppliers s
                LEFT JOIN inventoryitems ii ON s.id = ii.supplier_id
                GROUP BY s.id
                ORDER BY s.name
            `;
            
            const result = await this.pgPool.query(query);
            return result.rows;
        } catch (error) {
            console.error('Error getting all suppliers:', error);
            throw error;
        }
    }

    async deleteSupplier(id) {
        const client = await this.pgPool.connect();
        try {
            await client.query('BEGIN');

            // Check if supplier has any inventory items
            const checkQuery = `
                SELECT COUNT(*) as count 
                FROM inventoryitems 
                WHERE supplier_id = $1
            `;
            const checkResult = await client.query(checkQuery, [id]);
            
            if (checkResult.rows[0].count > 0) {
                throw new Error('Cannot delete supplier with associated inventory items');
            }

            // Delete supplier
            const deleteQuery = 'DELETE FROM suppliers WHERE id = $1 RETURNING *';
            const result = await client.query(deleteQuery, [id]);

            await client.query('COMMIT');
            return result.rows[0];
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error deleting supplier:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    async getSupplierOrders(supplierId) {
        try {
            const query = `
                SELECT 
                    po.*,
                    COUNT(poi.id) as total_items,
                    SUM(poi.quantity) as total_quantity
                FROM procurementorders po
                LEFT JOIN procurementorderitems poi ON po.id = poi.procurement_order_id
                WHERE po.supplier_id = $1
                GROUP BY po.id
                ORDER BY po.order_date DESC
            `;
            
            const result = await this.pgPool.query(query, [supplierId]);
            return result.rows;
        } catch (error) {
            console.error('Error getting supplier orders:', error);
            throw error;
        }
    }
}

module.exports = new SupplierService(); 