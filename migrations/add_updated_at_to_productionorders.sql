-- Migration: Add updated_at column to ProductionOrders table
-- Date: $(date '+%Y-%m-%d')

-- Add the updated_at column with a default timestamp
ALTER TABLE productionorders ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Description:
-- This migration adds an 'updated_at' timestamp column to the productionorders table.
-- The column is used by the application to track when records are updated.
-- The DEFAULT CURRENT_TIMESTAMP ensures that existing records get a timestamp automatically. 