-- Migration: Document the complete structure of the ProductionOrders table
-- Date: 2023-11-19

-- This migration documents the complete structure of the ProductionOrders table
-- as it exists in the production database. It should NOT be run on existing
-- databases but serves as documentation of the current structure.

/*
The ProductionOrders table has the following columns:
- id: SERIAL PRIMARY KEY
- product_sku: VARCHAR(50) NOT NULL - The SKU of the product being produced
- quantity: INTEGER NOT NULL - The quantity to produce
- status: VARCHAR(20) DEFAULT 'Pending' - Current status of the production order
- finished_batch_number: VARCHAR(50) - Batch number assigned to finished goods
- mmr_product_sku: VARCHAR(50) NOT NULL - Reference to MMR product_sku
- mmr_version: INTEGER NOT NULL - Reference to MMR version
- mmr_base_quantity: NUMERIC DEFAULT 1 - Base quantity for MMR scaling
- due_date: DATE - Due date for the production order
- completed_at: TIMESTAMP - When the order was completed
- actual_yield: NUMERIC - Actual yield of the production
- completed_by: VARCHAR(50) - Who completed the production order
- updated_at: TIMESTAMP DEFAULT CURRENT_TIMESTAMP - Track when records are updated

Indexes:
- "productionorders_pkey" PRIMARY KEY, btree (id)
- "idx_production_orders_mmr" btree (mmr_product_sku, mmr_version)

Foreign-key constraints:
- "productionorders_mmr_fkey" FOREIGN KEY (mmr_product_sku, mmr_version) REFERENCES mmrs(product_sku, version)

Referenced by:
- TABLE "productionbatches" CONSTRAINT "productionbatches_production_order_id_fkey" 
  FOREIGN KEY (production_order_id) REFERENCES productionorders(id)
- TABLE "productionordertestreports" CONSTRAINT "productionordertestreports_production_order_id_fkey" 
  FOREIGN KEY (production_order_id) REFERENCES productionorders(id) ON DELETE CASCADE
- TABLE "productionreports" CONSTRAINT "productionreports_production_order_id_fkey" 
  FOREIGN KEY (production_order_id) REFERENCES productionorders(id)
- TABLE "productionsteps" CONSTRAINT "productionsteps_production_order_id_fkey" 
  FOREIGN KEY (production_order_id) REFERENCES productionorders(id)

Triggers:
- update_productionorders_updated_at BEFORE UPDATE ON productionorders 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
*/

-- For reference, if creating this table from scratch, this would be the SQL:

/*
CREATE TABLE ProductionOrders (
  id SERIAL PRIMARY KEY,
  product_sku VARCHAR(50) NOT NULL,
  quantity INT NOT NULL,
  status VARCHAR(20) DEFAULT 'Pending',
  finished_batch_number VARCHAR(50),
  mmr_product_sku VARCHAR(50) NOT NULL,
  mmr_version INT NOT NULL,
  mmr_base_quantity NUMERIC DEFAULT 1,
  due_date DATE,
  completed_at TIMESTAMP,
  actual_yield NUMERIC,
  completed_by VARCHAR(50),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (mmr_product_sku, mmr_version) REFERENCES MMRs(product_sku, version)
);

CREATE INDEX idx_production_orders_mmr ON ProductionOrders(mmr_product_sku, mmr_version);

CREATE TRIGGER update_productionorders_updated_at
  BEFORE UPDATE ON ProductionOrders
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
*/ 