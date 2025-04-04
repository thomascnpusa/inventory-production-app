-- Add FBA inventory column to InventoryItems table
ALTER TABLE InventoryItems
ADD COLUMN fba_inventory INT DEFAULT 0;

-- Create an index for faster searches
CREATE INDEX IF NOT EXISTS idx_inventory_fba ON InventoryItems(fba_inventory);

-- Add last_fba_update column to track when FBA inventory was last updated
ALTER TABLE InventoryItems
ADD COLUMN last_fba_update TIMESTAMP; 