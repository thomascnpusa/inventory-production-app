-- Drop existing tables and triggers
DROP TRIGGER IF EXISTS update_mmr_steps_updated_at ON MMRSteps;
DROP TRIGGER IF EXISTS update_mmr_ingredients_updated_at ON MMRIngredients;
DROP TRIGGER IF EXISTS update_mmr_updated_at ON MMRs;
DROP TABLE IF EXISTS MMRSteps;
DROP TABLE IF EXISTS MMRIngredients;
DROP TABLE IF EXISTS MMRs;
DROP TABLE IF EXISTS ProductionBatches;

-- Create MMRs table
CREATE TABLE IF NOT EXISTS MMRs (
    product_sku VARCHAR(50) NOT NULL,
    version INTEGER NOT NULL,
    base_quantity DECIMAL(10,2) NOT NULL,
    created_by VARCHAR(100) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT true,
    PRIMARY KEY (product_sku, version)
);

-- Create MMRIngredients table
CREATE TABLE IF NOT EXISTS MMRIngredients (
    mmr_product_sku VARCHAR(50) NOT NULL,
    mmr_version INTEGER NOT NULL,
    ingredient_sku VARCHAR(50) NOT NULL,
    quantity DECIMAL(10,2) NOT NULL,
    unit_type VARCHAR(50) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (mmr_product_sku, mmr_version) REFERENCES MMRs(product_sku, version),
    FOREIGN KEY (ingredient_sku) REFERENCES InventoryItems(sku)
);

-- Create MMRSteps table
CREATE TABLE IF NOT EXISTS MMRSteps (
    mmr_product_sku VARCHAR(50) NOT NULL,
    mmr_version INTEGER NOT NULL,
    step_number INTEGER NOT NULL,
    description TEXT NOT NULL,
    quality_checks TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (mmr_product_sku, mmr_version) REFERENCES MMRs(product_sku, version)
);

-- Create Production Batches table
CREATE TABLE IF NOT EXISTS ProductionBatches (
  id SERIAL PRIMARY KEY,
  production_order_id INT REFERENCES ProductionOrders(id),
  item_id INT REFERENCES InventoryItems(id),
  batch_number VARCHAR(50),  -- Batch of raw material, packaging, or label used
  quantity_used DECIMAL(10,4),     -- Amount of raw material, packaging, or label consumed (in inventory units)
  item_type VARCHAR(20),      -- 'raw_ingredient', 'packaging', or 'label'
  original_unit VARCHAR(20),  -- Unit specified in the MMR
  inventory_unit VARCHAR(20), -- Unit used in inventory
  conversion_factor DECIMAL(10,4), -- Factor used to convert between original and inventory units
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_mmr_product_sku ON MMRs(product_sku);
CREATE INDEX IF NOT EXISTS idx_mmr_version ON MMRs(version);
CREATE INDEX IF NOT EXISTS idx_mmr_ingredients_sku ON MMRIngredients(ingredient_sku);
CREATE INDEX IF NOT EXISTS idx_mmr_steps_product ON MMRSteps(mmr_product_sku, mmr_version);

-- Create triggers to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_mmr_updated_at
    BEFORE UPDATE ON MMRs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_mmr_ingredients_updated_at
    BEFORE UPDATE ON MMRIngredients
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_mmr_steps_updated_at
    BEFORE UPDATE ON MMRSteps
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column(); 